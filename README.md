# DexScreener MCP Server

Cloudflare Workers remote MCP server for read-only public DexScreener data.

## Files
- package.json
- wrangler.jsonc
- src/index.js

## Endpoints
- `/` status
- `/health` JSON health check
- `/mcp` MCP endpoint

## Reliability behavior

- Successful DexScreener responses are fresh for 10 seconds and retained for a short stale fallback window.
- Concurrent requests for the same endpoint share one upstream request.
- HTTP 429 and Cloudflare Error 1015 responses trigger a shared 30-second cooldown (up to 120 seconds when DexScreener supplies `Retry-After`) and are cached to prevent retry storms.
- `get_cashcat` performs one fixed-contract lookup on the Robinhood Chain, without a search or follow-up pair requests.

The Worker remains deployable with `npm run deploy` and keeps the remote MCP endpoint at `/mcp`.
