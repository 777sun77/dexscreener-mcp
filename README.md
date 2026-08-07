# DexScreener MCP Server

Cloudflare Workers remote MCP server exposing DexScreener public API data.

## Deploy

1. Import this repository into Cloudflare Workers.
2. Build command: leave empty unless Cloudflare asks for one.
3. Deploy command: `npx wrangler deploy`
4. MCP endpoint after deploy:
   `https://<worker-name>.<account>.workers.dev/mcp`

## Tools

- `search_dexscreener`
- `get_pair`
- `get_token`
- `get_token_pairs`
- `get_latest_boosted_tokens`
- `get_top_boosted_tokens`
