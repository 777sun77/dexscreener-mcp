# DexScreener MCP Server

Cloudflare Workers remote MCP server for read-only public DexScreener data.

## Endpoints
- `/` status
- `/health` JSON health check
- `/mcp` Streamable HTTP MCP endpoint

## Tools
- `search_dexscreener`
- `get_token`
- `get_token_pairs`
- `get_pair`
- `get_latest_boosted_tokens`
- `get_top_boosted_tokens`

All tools declare MCP read-only/non-destructive annotations.
