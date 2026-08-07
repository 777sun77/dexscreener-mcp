import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const VERSION = "1.2.0";
const API_BASE = "https://api.dexscreener.com";
const CACHE_TTL_MS = 10_000;
const STALE_CACHE_TTL_MS = 60_000;
const RATE_LIMIT_BACKOFF_MS = 30_000;
const MAX_RATE_LIMIT_BACKOFF_MS = 120_000;
const RATE_LIMIT_CACHE_PATH = "/__dexscreener_rate_limit__";

const CASHCAT = {
  chainId: "robinhood",
  tokenAddress: "0x020bfC650A365f8BB26819deAAbF3E21291018b4"
};

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
};

// Cloudflare's Cache API persists these entries between Worker isolates. The
// in-memory maps also collapse concurrent requests in the same isolate.
const memoryCache = new Map();
const inFlight = new Map();
let rateLimitUntil = 0;

class DexScreenerError extends Error {
  constructor(message, status = 502, retryAfterMs = 0, cached = false) {
    super(message);
    this.name = "DexScreenerError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.cached = cached;
  }
}

function getEdgeCache() {
  return typeof caches !== "undefined" && caches.default ? caches.default : null;
}

function cacheRequest(path) {
  return new Request(`${API_BASE}${path}`, { method: "GET" });
}

function now() {
  return Date.now();
}

function isUsableEntry(entry, currentTime = now()) {
  return entry && entry.expiresAt > currentTime;
}

async function readCache(path) {
  const currentTime = now();
  const inMemory = memoryCache.get(path);
  if (isUsableEntry(inMemory, currentTime)) {
    return inMemory;
  }

  if (inMemory) {
    memoryCache.delete(path);
  }

  const edgeCache = getEdgeCache();
  if (!edgeCache) {
    return null;
  }

  const cachedResponse = await edgeCache.match(cacheRequest(path));
  if (!cachedResponse) {
    return null;
  }

  try {
    const envelope = await cachedResponse.json();
    const entry = {
      kind: envelope.kind,
      data: envelope.data,
      status: envelope.status,
      message: envelope.message,
      retryAfterMs: envelope.retryAfterMs || 0,
      freshUntil: envelope.freshUntil || 0,
      expiresAt: envelope.expiresAt || 0
    };

    if (!isUsableEntry(entry, currentTime)) {
      memoryCache.delete(path);
      return null;
    }

    memoryCache.set(path, entry);
    return entry;
  } catch {
    // A malformed cache entry should never prevent a fresh upstream request.
    return null;
  }
}

async function writeCache(path, entry, ttlMs, freshTtlMs = ttlMs) {
  const currentTime = now();
  const cacheEntry = {
    ...entry,
    freshUntil: currentTime + freshTtlMs,
    expiresAt: currentTime + ttlMs
  };
  memoryCache.set(path, cacheEntry);

  const edgeCache = getEdgeCache();
  if (!edgeCache) {
    return;
  }

  const response = new Response(JSON.stringify(cacheEntry), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${Math.ceil(ttlMs / 1000)}`
    }
  });

  try {
    await edgeCache.put(cacheRequest(path), response);
  } catch (error) {
    // The Worker remains functional if the optional edge cache is unavailable.
    console.warn("DexScreener cache write failed", error);
  }
}

function rateLimitError(retryAfterMs, cached = false) {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return new DexScreenerError(
    `DexScreener rate limit cooldown is active; retry in about ${seconds}s.`,
    429,
    retryAfterMs,
    cached
  );
}

function throwCachedError(entry) {
  if (entry.kind === "rate-limit") {
    throw rateLimitError(entry.retryAfterMs || RATE_LIMIT_BACKOFF_MS, true);
  }

  throw new DexScreenerError(
    entry.message || "DexScreener request failed and is temporarily cached.",
    entry.status || 502,
    entry.retryAfterMs || 0,
    true
  );
}

function rememberRateLimit(retryAfterMs) {
  rateLimitUntil = Math.max(rateLimitUntil, now() + retryAfterMs);
}

async function getRateLimitCooldownMs() {
  const currentTime = now();
  if (rateLimitUntil > currentTime) {
    return rateLimitUntil - currentTime;
  }

  const entry = await readCache(RATE_LIMIT_CACHE_PATH);
  if (entry?.kind === "rate-limit" && entry.expiresAt > currentTime) {
    rateLimitUntil = entry.expiresAt;
    return entry.expiresAt - currentTime;
  }

  return 0;
}

function parseRetryAfterMs(response) {
  const value = response.headers.get("retry-after");
  if (!value) {
    return 0;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now()) : 0;
}

function isRateLimited(response, body) {
  if (response.status === 429) {
    return true;
  }

  return response.status === 403 && /error\s*1015|rate.?limit|too many requests/i.test(body);
}

function getBackoffMs(response) {
  return Math.min(
    MAX_RATE_LIMIT_BACKOFF_MS,
    Math.max(RATE_LIMIT_BACKOFF_MS, parseRetryAfterMs(response))
  );
}

async function fetchFromDexScreener(path) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": `dexscreener-mcp/${VERSION}`
    }
  });
  const body = await response.text();

  if (!response.ok) {
    const message = `DexScreener API ${response.status}: ${body.slice(0, 500)}`;
    const error = new DexScreenerError(
      message,
      response.status,
      parseRetryAfterMs(response)
    );

    if (isRateLimited(response, body)) {
      const backoffMs = getBackoffMs(response);
      rememberRateLimit(backoffMs);
      await Promise.all([
        writeCache(
          path,
          {
            kind: "rate-limit",
            status: 429,
            message,
            retryAfterMs: backoffMs
          },
          backoffMs
        ),
        writeCache(
          RATE_LIMIT_CACHE_PATH,
          {
            kind: "rate-limit",
            status: 429,
            message,
            retryAfterMs: backoffMs
          },
          backoffMs
        )
      ]);
      throw rateLimitError(backoffMs);
    }

    // Avoid retry storms for short-lived upstream failures without hiding the
    // original status from the MCP client.
    await writeCache(
      path,
      { kind: "error", status: error.status, message: error.message },
      5_000
    );
    throw error;
  }

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new DexScreenerError("DexScreener returned invalid JSON.", 502);
  }

  await writeCache(
    path,
    { kind: "success", data },
    STALE_CACHE_TTL_MS,
    CACHE_TTL_MS
  );
  return data;
}

async function dexFetch(path) {
  const cached = await readCache(path);
  if (cached?.kind === "success" && cached.freshUntil > now()) {
    return cached.data;
  }
  if (cached && cached.kind !== "success") {
    throwCachedError(cached);
  }

  const cooldownMs = await getRateLimitCooldownMs();
  if (cooldownMs > 0) {
    // A recent result is more useful than issuing another request during a
    // known provider cooldown. It is retained for this brief fallback window.
    if (cached?.kind === "success") {
      return cached.data;
    }
    throw rateLimitError(cooldownMs, true);
  }

  const existingRequest = inFlight.get(path);
  if (existingRequest) {
    return existingRequest;
  }

  const request = (async () => {
    const latestCached = await readCache(path);
    if (latestCached?.kind === "success" && latestCached.freshUntil > now()) {
      return latestCached.data;
    }
    if (latestCached && latestCached.kind !== "success") {
      throwCachedError(latestCached);
    }

    const latestCooldownMs = await getRateLimitCooldownMs();
    if (latestCooldownMs > 0) {
      if (latestCached?.kind === "success") {
        return latestCached.data;
      }
      throw rateLimitError(latestCooldownMs, true);
    }

    try {
      return await fetchFromDexScreener(path);
    } catch (error) {
      if (error instanceof DexScreenerError && error.status === 429) {
        const stale = latestCached?.kind === "success" ? latestCached : cached;
        if (stale?.kind === "success") {
          console.warn("Returning stale DexScreener data during rate-limit cooldown", path);
          return stale.data;
        }
      }
      throw error;
    }
  })();

  inFlight.set(path, request);
  try {
    return await request;
  } finally {
    inFlight.delete(path);
  }
}

function tokenPath(chainId, tokenAddress) {
  return `/tokens/v1/${encodeURIComponent(chainId.trim().toLowerCase())}/${encodeURIComponent(tokenAddress.trim().toLowerCase())}`;
}

function pairPath(chainId, pairAddress) {
  return `/latest/dex/pairs/${encodeURIComponent(chainId.trim().toLowerCase())}/${encodeURIComponent(pairAddress.trim().toLowerCase())}`;
}

function tokenPairsPath(chainId, tokenAddress) {
  return `/token-pairs/v1/${encodeURIComponent(chainId.trim().toLowerCase())}/${encodeURIComponent(tokenAddress.trim().toLowerCase())}`;
}

function result(data) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data)
      }
    ]
  };
}

function makeServer() {
  const server = new McpServer({
    name: "dexscreener-mcp",
    version: VERSION
  });

  server.registerTool(
    "search_dexscreener",
    {
      title: "Search DexScreener",
      description:
        "Read-only search of public DexScreener market data by token name, ticker, token address, or pair address. Results are cached briefly to avoid duplicate upstream calls.",
      annotations: READ_ONLY,
      inputSchema: {
        query: z.string().min(1).max(200).describe(
          "Token name, ticker, token contract address, or pair address. Example: BTC or CASHCAT."
        )
      }
    },
    async ({ query }) =>
      result(
        await dexFetch(`/latest/dex/search?q=${encodeURIComponent(query.trim().toLowerCase())}`)
      )
  );

  server.registerTool(
    "get_cashcat",
    {
      title: "Get CASHCAT Market Data",
      description:
        "Read-only one-call lookup for CASHCAT on the Robinhood Chain using its fixed contract 0x020bfC650A365f8BB26819deAAbF3E21291018b4. The result is cached briefly and does not perform a search or follow-up pair calls.",
      annotations: READ_ONLY,
      inputSchema: {}
    },
    async () => result(await dexFetch(tokenPath(CASHCAT.chainId, CASHCAT.tokenAddress)))
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
        tokenAddress: z.string().min(1).max(200).describe(
          "Token contract address."
        )
      }
    },
    async ({ chainId, tokenAddress }) =>
      result(await dexFetch(tokenPath(chainId, tokenAddress)))
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
      result(await dexFetch(tokenPairsPath(chainId, tokenAddress)))
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
      result(await dexFetch(pairPath(chainId, pairAddress)))
  );

  server.registerTool(
    "get_latest_boosted_tokens",
    {
      title: "Latest Boosted Tokens",
      description:
        "Read-only lookup of the latest public token boosts on DexScreener.",
      annotations: READ_ONLY,
      inputSchema: {}
    },
    async () => result(await dexFetch("/token-boosts/latest/v1"))
  );

  server.registerTool(
    "get_top_boosted_tokens",
    {
      title: "Top Boosted Tokens",
      description:
        "Read-only lookup of the most active public token boosts on DexScreener.",
      annotations: READ_ONLY,
      inputSchema: {}
    },
    async () => result(await dexFetch("/token-boosts/top/v1"))
  );

  return server;
}

const mcpHandler = createMcpHandler(makeServer);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    console.log(
      JSON.stringify({
        method: request.method,
        path: url.pathname,
        userAgent: request.headers.get("user-agent"),
        contentType: request.headers.get("content-type")
      })
    );

    if (url.pathname === "/") {
      return new Response(
        "DexScreener MCP server is running. MCP endpoint: /mcp",
        {
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store"
          }
        }
      );
    }

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "dexscreener-mcp",
        version: VERSION,
        mcp: "/mcp"
      });
    }

    if (url.pathname === "/mcp") {
      return mcpHandler(request, env, ctx);
    }

    return new Response("Not Found", { status: 404 });
  }
};
