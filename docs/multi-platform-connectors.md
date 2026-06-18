# Multi-Platform MCP Connectors

DevSpace exposes a standard Streamable HTTP MCP endpoint at `/mcp`. Different
hosted MCP clients support different authentication methods. Keep the server
configuration generic: OAuth remains the default, and static bearer-token auth is
available for clients that support header-based authentication.

## Server URL

Configure clients with the full MCP endpoint:

```text
https://your-tunnel-host.example.com/mcp
```

`DEVSPACE_PUBLIC_BASE_URL` should be the origin without `/mcp`:

```bash
DEVSPACE_PUBLIC_BASE_URL="https://your-tunnel-host.example.com"
```

## OAuth Clients

ChatGPT, Claude.ai, and other OAuth-capable MCP clients can use DevSpace's
single-user OAuth approval flow. For hosted clients, allow their callback hosts:

```bash
DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS="chatgpt.com,chat.openai.com,claude.ai,grok.com,localhost,127.0.0.1"
```

If the server sits behind one reverse proxy hop such as Cloudflare Tunnel, enable
proxy trust:

```bash
DEVSPACE_TRUST_PROXY=true
```

DevSpace trusts exactly one proxy hop when this flag is enabled.

## Header-Based / Bearer-Token Clients

Some MCP clients support API-key or bearer-token authentication instead of OAuth.
For those clients, set a static bearer token when starting DevSpace:

```bash
DEVSPACE_STATIC_BEARER_TOKEN="$(openssl rand -base64 32)" \
DEVSPACE_PUBLIC_BASE_URL="https://your-tunnel-host.example.com" \
DEVSPACE_TRUST_PROXY=true \
npx @waishnav/devspace serve
```

Then configure the MCP client with:

- URL: `https://your-tunnel-host.example.com/mcp`
- Auth type: Bearer token / API key / header-based auth

If the client asks for a bearer token value, paste only the token. If it asks for
a raw header, use:

```text
Authorization: Bearer <token>
```

Do not commit this token. Treat it like a password: anyone who has it can use the
DevSpace tools exposed by your allowed roots.

## Known Client Notes

| Client | Recommended auth | Notes |
| --- | --- | --- |
| ChatGPT custom connector | OAuth | Uses dynamic client registration and Owner password approval. |
| Claude.ai custom connector | OAuth | Add `claude.ai` to `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS`. |
| Grok custom connector | OAuth | Some clients omit the OAuth `resource` parameter; DevSpace defaults it to the MCP resource URL. |
| Notion Custom Agent | Bearer token | Use Notion's header-based / bearer-token authentication for custom MCP servers. |
| Cursor / other local MCP clients | OAuth or bearer | Pick the auth mode the client supports. |

## Quick Verification

With bearer auth enabled:

```bash
TOKEN="$DEVSPACE_STATIC_BEARER_TOKEN"

curl -I https://your-tunnel-host.example.com/mcp \
  -H "Authorization: Bearer $TOKEN"
# expected: 204

curl -sS -D - https://your-tunnel-host.example.com/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl-test","version":"0.1.0"}}}'
# expected: 200 with MCP server capabilities
```
