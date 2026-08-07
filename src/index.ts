import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const API_BASE = "https://api.dexscreener.com";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

async function dexFetch(path: string): Promise<unknown> {
  const r = await fetch(`${API_BASE}${path}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": "dexscreener-mcp/1.1"
    }
  });

  if (!r.ok) {
    const body = await r.text();
    throw new Error(`DexScreener API ${r.status}: ${body.slice(0, 500)}`);
  }

  return r.json();
}

function result(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }]
  };
}

function makeServer() {
  const server = new McpServer({
    name: "dexscreener-mcp",
    version: "1.1.0"
  });

  server.registerTool(
    "search_dexscreener",
    {
      title: "Search DexScreener",
      description:
        "Read-only search of public DexScreener market data by token name, ticker, token address, or pair address.",
      annotations: READ_ONLY,
      inputSchema: {
        query: z.string().min(1).max(200).describe(
          "Token name, ticker, token address, or pair address. Example: BTC or CASHCAT."
        )
      }
    },
    async ({ query }) =>
      result(await dexFetch(`/latest/dex/search?q=${encodeURIComponent(query)}`))
  );

  server.registerTool(
    "get_token",
    {
      title: "Get Token Market Data",
      description:
        "Read-only lookup of public DexScreener market data for one token contract on a specified chain.",
      annotations: READ_ONLY,
      inputSchema: {
        chainId: z.string().min(1).max(80).describe(
          "DexScreener chain ID, such as ethereum, solana, base, or robinhood."
        ),
        tokenAddress: z.string().min(1).max(200).describe("Token contract address.")
      }
    },
    async ({ chainId, tokenAddress }) =>
      result(await dexFetch(
        `/tokens/v1/${encodeURIComponent(chainId)}/${encodeURIComponent(tokenAddress)}`
      ))
  );

  server.registerTool(
    "get_token_pairs",
    {
      title: "Get Token Trading Pairs",
      description:
        "Read-only lookup of public DexScreener trading pairs and liquidity pools for a token contract.",
      annotations: READ_ONLY,
      inputSchema: {
        chainId: z.string().min(1).max(80),
        tokenAddress: z.string().min(1).max(200)
      }
    },
    async ({ chainId, tokenAddress }) =>
      result(await dexFetch(
        `/token-pairs/v1/${encodeURIComponent(chainId)}/${encodeURIComponent(tokenAddress)}`
      ))
  );

  server.registerTool(
    "get_pair",
    {
      title: "Get Trading Pair",
      description:
        "Read-only lookup of public DexScreener data for a specific trading pair.",
      annotations: READ_ONLY,
      inputSchema: {
        chainId: z.string().min(1).max(80),
        pairAddress: z.string().min(1).max(200)
      }
    },
    async ({ chainId, pairAddress }) =>
      result(await dexFetch(
        `/latest/dex/pairs/${encodeURIComponent(chainId)}/${encodeURIComponent(pairAddress)}`
      ))
  );

  server.registerTool(
    "get_latest_boosted_tokens",
    {
      title: "Latest Boosted Tokens",
      description: "Read-only lookup of the latest public token boosts on DexScreener.",
      annotations: READ_ONLY,
      inputSchema: {}
    },
    async () => result(await dexFetch("/token-boosts/latest/v1"))
  );

  server.registerTool(
    "get_top_boosted_tokens",
    {
      title: "Top Boosted Tokens",
      description: "Read-only lookup of the most active public token boosts on DexScreener.",
      annotations: READ_ONLY,
      inputSchema: {}
    },
    async () => result(await dexFetch("/token-boosts/top/v1"))
  );

  return server;
}

const mcpHandler = createMcpHandler(makeServer);

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    console.log(JSON.stringify({
      method: request.method,
      path: url.pathname,
      userAgent: request.headers.get("user-agent"),
      contentType: request.headers.get("content-type")
    }));

    if (url.pathname === "/") {
      return new Response("DexScreener MCP server is running. MCP endpoint: /mcp", {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store"
        }
      });
    }

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "dexscreener-mcp",
        version: "1.1.0",
        mcp: "/mcp"
      });
    }

    if (url.pathname === "/mcp") {
      return mcpHandler(request, env, ctx);
    }

    return new Response("Not Found", { status: 404 });
  }
} satisfies ExportedHandler;
