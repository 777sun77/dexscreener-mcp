import assert from "node:assert/strict";
import test from "node:test";

const upstreamCalls = [];
let upstreamMode = "success";

globalThis.fetch = async (input) => {
  upstreamCalls.push(String(input));

  if (upstreamMode === "rate-limit") {
    return new Response("Error 1015", {
      status: 429,
      headers: { "content-type": "text/plain" }
    });
  }

  return new Response(JSON.stringify({ pairs: [{ priceUsd: "1" }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};

const { default: worker } = await import("../src/index.js");

async function mcpCall(id, name, arguments_ = {}) {
  const response = await worker.fetch(
    new Request("https://example.com/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: arguments_ }
      })
    }),
    {},
    undefined
  );
  const event = (await response.text())
    .split("\n")
    .find((line) => line.startsWith("data: "));
  return JSON.parse(event.slice("data: ".length));
}

test("health and root routes remain available", async () => {
  const health = await worker.fetch(new Request("https://example.com/health"));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    service: "dexscreener-mcp",
    version: "1.2.0",
    mcp: "/mcp"
  });

  const root = await worker.fetch(new Request("https://example.com/"));
  assert.equal(root.status, 200);
  assert.match(await root.text(), /MCP endpoint: \/mcp/);
});

test("CASHCAT is a fixed one-call tool and concurrent calls collapse", async () => {
  upstreamMode = "success";
  upstreamCalls.length = 0;

  const [first, second] = await Promise.all([
    mcpCall(1, "get_cashcat"),
    mcpCall(2, "get_cashcat")
  ]);
  const third = await mcpCall(3, "get_cashcat");

  assert.equal(first.result.isError, undefined);
  assert.equal(second.result.isError, undefined);
  assert.equal(third.result.isError, undefined);
  assert.equal(upstreamCalls.length, 1);
  assert.match(upstreamCalls[0], /\/tokens\/v1\/robinhood\/0x020bf/);
});

test("429/Error 1015 responses trigger a shared cooldown", async () => {
  upstreamMode = "rate-limit";
  upstreamCalls.length = 0;

  const first = await mcpCall(4, "get_latest_boosted_tokens");
  const second = await mcpCall(5, "get_latest_boosted_tokens");
  const differentEndpoint = await mcpCall(6, "get_top_boosted_tokens");

  assert.equal(first.result.isError, true);
  assert.equal(second.result.isError, true);
  assert.equal(differentEndpoint.result.isError, true);
  assert.equal(upstreamCalls.length, 1);
  assert.match(first.result.content[0].text, /retry in about 30s/);
});
