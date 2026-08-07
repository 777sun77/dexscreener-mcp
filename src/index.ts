import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const API_BASE = "https://api.dexscreener.com";

async function dexFetch(path: string) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `DexScreener API ${response.status}: ${body.slice(0, 500)}`
    );
  }

  return response.json();
}

function textResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function createServer() {
  const server = new McpServer({
    name: "dexscreener-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "search_dexscreener",
    {
      description:
        "Search DexScreener by token name, symbol, token address, or pair address. Useful for live price, market cap, FDV, liquidity, volume, transactions, and price changes.",
      inputSchema: {
        query: z.string().min(1).describe(
          "Token name, symbol, token address, or pair address, e.g. CASHCAT"
        ),
      },
    },
    async ({ query }) =>
      textResult(
        await dexFetch(`/latest/dex/search?q=${encodeURIComponent(query)}`)
      )
  );

  server.registerTool(
    "get_pair",
    {
      description:
        "Get live DexScreener data for a specific trading pair by chain ID and pair address.",
      inputSchema: {
        chainId: z.string().min(1).describe("e.g. solana, ethereum, base"),
        pairAddress: z.string().min(1).describe("Pair contract/address"),
      },
    },
    async ({ chainId, pairAddress }) =>
      textResult(
        await dexFetch(
          `/latest/dex/pairs/${encodeURIComponent(chainId)}/${encodeURIComponent(pairAddress)}`
        )
      )
  );

  server.registerTool(
    "get_token",
    {
      description:
        "Get live DexScreener market data for a token by chain ID and token contract address.",
      inputSchema: {
        chainId: z.string().min(1).describe("e.g. solana, ethereum, base"),
        tokenAddress: z.string().min(1).describe("Token contract address"),
      },
    },
    async ({ chainId, tokenAddress }) =>
      textResult(
        await dexFetch(
          `/tokens/v1/${encodeURIComponent(chainId)}/${encodeURIComponent(tokenAddress)}`
        )
      )
  );

  server.registerTool(
    "get_token_pairs",
    {
      description:
        "Get all DexScreener trading pairs/liquidity pools for a token contract on a chain.",
      inputSchema: {
        chainId: z.string().min(1).describe("e.g. solana, ethereum, base"),
        tokenAddress: z.string().min(1).describe("Token contract address"),
      },
    },
    async ({ chainId, tokenAddress }) =>
      textResult(
        await dexFetch(
          `/token-pairs/v1/${encodeURIComponent(chainId)}/${encodeURIComponent(tokenAddress)}`
        )
      )
  );

  server.registerTool(
    "get_latest_boosted_tokens",
    {
      description: "Get the latest tokens receiving boosts on DexScreener.",
      inputSchema: {},
    },
    async () => textResult(await dexFetch("/token-boosts/latest/v1"))
  );

  server.registerTool(
    "get_top_boosted_tokens",
    {
      description: "Get the tokens with the most active boosts on DexScreener.",
      inputSchema: {},
    },
    async () => textResult(await dexFetch("/token-boosts/top/v1"))
  );

  return server;
}

const mcpHandler = createMcpHandler(createServer);

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(
        "DexScreener MCP server is running. Connect to /mcp",
        { headers: { "content-type": "text/plain; charset=utf-8" } }
      );
    }

    if (url.pathname === "/mcp") {
      return mcpHandler(request, env, ctx);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler;
