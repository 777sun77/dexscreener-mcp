import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const API = "https://api.dexscreener.com";

async function dexFetch(path) {
  const response = await fetch(`${API}${path}`, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `DexScreener API error: ${response.status} ${response.statusText}`
    );
  }

  return response.json();
}

function asText(data) {
  return {
    content: [
      {
        type: "text",
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

  // 이름 / 심볼 / 주소로 검색
  server.registerTool(
    "search_dexscreener",
    {
      description:
        "Search DexScreener for a cryptocurrency token or trading pair by token name, symbol, token address, or pair address. Returns current price, market cap, FDV, liquidity, volume, transactions, and price changes.",
      inputSchema: {
        query: z.string().describe(
          "Token name, ticker symbol, token address, or pair address, for example CASHCAT, PONS, SOL/USDC"
        ),
      },
    },
    async ({ query }) => {
      const data = await dexFetch(
        `/latest/dex/search?q=${encodeURIComponent(query)}`
      );

      return asText(data);
    }
  );

  // 토큰 컨트랙트 주소로 풀 조회
  server.registerTool(
    "get_token_pairs",
    {
      description:
        "Get all DexScreener liquidity pools and trading pairs for a specific token contract address on a blockchain.",
      inputSchema: {
        chainId: z.string().describe(
          "DexScreener chain ID, for example solana, ethereum, base"
        ),
        tokenAddress: z.string().describe("Token contract address"),
      },
    },
    async ({ chainId, tokenAddress }) => {
      const data = await dexFetch(
        `/token-pairs/v1/${encodeURIComponent(chainId)}/${encodeURIComponent(
          tokenAddress
        )}`
      );

      return asText(data);
    }
  );

  // 특정 페어
  server.registerTool(
    "get_pair",
    {
      description:
        "Get current DexScreener information for a specific trading pair using its chain and pair address.",
      inputSchema: {
        chainId: z.string().describe("DexScreener chain ID"),
        pairAddress: z.string().describe("Trading pair contract address"),
      },
    },
    async ({ chainId, pairAddress }) => {
      const data = await dexFetch(
        `/latest/dex/pairs/${encodeURIComponent(
          chainId
        )}/${encodeURIComponent(pairAddress)}`
      );

      return asText(data);
    }
  );

  // 토큰 주소 직접 조회
  server.registerTool(
    "get_token",
    {
      description:
        "Get live DexScreener market data for a token contract address, including price, market cap, FDV, liquidity, volume and price changes.",
      inputSchema: {
        chainId: z.string().describe("DexScreener chain ID"),
        tokenAddress: z.string().describe("Token contract address"),
      },
    },
    async ({ chainId, tokenAddress }) => {
      const data = await dexFetch(
        `/tokens/v1/${encodeURIComponent(chainId)}/${encodeURIComponent(
          tokenAddress
        )}`
      );

      return asText(data);
    }
  );

  // 최신 부스트
  server.registerTool(
    "get_latest_boosted_tokens",
    {
      description:
        "Get the latest tokens receiving boosts on DexScreener.",
      inputSchema: {},
    },
    async () => {
      const data = await dexFetch("/token-boosts/latest/v1");
      return asText(data);
    }
  );

  // 가장 많이 부스트된 토큰
  server.registerTool(
    "get_top_boosted_tokens",
    {
      description:
        "Get tokens with the most active boosts on DexScreener.",
      inputSchema: {},
    },
    async () => {
      const data = await dexFetch("/token-boosts/top/v1");
      return asText(data);
    }
  );

  return server;
}

const mcpHandler = createMcpHandler(createServer);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 브라우저에서 서버 살아있는지 확인
    if (url.pathname === "/") {
      return new Response(
        "DexScreener MCP server is running. MCP endpoint: /mcp",
        {
          headers: {
            "content-type": "text/plain; charset=UTF-8",
          },
        }
      );
    }

    // MCP endpoint
    if (url.pathname === "/mcp") {
      return mcpHandler(request, env, ctx);
    }

    return new Response("Not Found", { status: 404 });
  },
};
