# Security Model

DevSpace exposes local coding capabilities over MCP. Treat it as remote access
to your development machine.

The security model is simple:

- you choose a narrow filesystem allowlist
- the MCP endpoint requires OAuth approval with your Owner password
- Host headers are allowlisted from the configured public URL
- every coding action happens through explicit MCP tool calls

## Filesystem Allowlist

DevSpace only opens workspaces under configured roots.

Good examples:

```text
~/work
~/personal/open-source
```

Avoid broad roots:

```text
~
/
C:\
```

The narrower the root, the easier it is to reason about what the MCP client can
reach.

## Owner Password

`devspace init` generates an Owner password and stores it in:

```text
~/.devspace/auth.json
```

When an MCP client connects, DevSpace shows an approval page. Enter the Owner
password only when you intentionally want that client to access this server.

Each DevSpace instance keeps one authorized MCP client. Approving a new client
deletes every previous client registration and its access and refresh tokens.
Use this command to revoke the current client before connecting a replacement:

```bash
devspace auth reset
```

Resetting authorization does not change the Owner password, public URL,
filesystem allowlist, tunnel configuration, or workspace state.

For env-driven deployments, set a long random value:

```bash
DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)"
```

## Public URL And Host Allowlist

DevSpace needs `DEVSPACE_PUBLIC_BASE_URL` so MCP clients can discover OAuth
metadata and connect to the correct resource.

The value should be the origin only:

```text
https://your-tunnel-host.example.com
```

Do not include `/mcp` in `DEVSPACE_PUBLIC_BASE_URL`.

By default, DevSpace derives allowed Host headers from the local host and public
URL. Use `DEVSPACE_ALLOWED_HOSTS=*` only for intentional local debugging.

## Tunnels

DevSpace does not manage tunnels. Your tunnel or reverse proxy should point to:

```text
http://127.0.0.1:7676
```

Prefer adding Cloudflare Access, Tailscale identity controls, or equivalent
protection in front of public tunnels. DevSpace OAuth still protects the MCP
endpoint, but the tunnel URL should not be treated as a secret.

## Shell Access

The shell tool is powerful by design. It is meant for tests, builds, git, and
package scripts.

Filesystem path containment applies to DevSpace file tools. Shell commands run
as local commands and can do what your user account can do. This is why the MCP
client must be trusted and the Owner password must stay private.

## Worktrees

Managed worktrees reduce accidental edits to your active checkout, but they are
not a security boundary. They are a workflow boundary for isolated coding
sessions.

## Native File Download

Native file download is an opt-in, one-shot transfer into an already-open
workspace. `download_artifact` accepts the MCP host's native file value, the
`workspaceId` returned by `open_workspace`, and an unused relative destination
path. It returns only the workspace-relative path and does not create a
persistent artifact service or reusable artifact ID.

DevSpace accepts only the documented native-file object and trusted OpenAI
download hosts and redirects. Arbitrary URL strings, local source paths,
credentials, malformed references, and unknown object fields are rejected.

Absolute paths, traversal, symlinked parents, and existing destinations also
fail closed. Downloads stream under the configured per-file limit and are
published without overwrite as owner-only files. DevSpace does not extract or
execute transferred content.

## macOS Computer Use

Local computer control is separately opt-in through
`DEVSPACE_COMPUTER_USE=1`. Every application or browser action requires an
active, authenticated DevSpace connection and a valid `workspaceId`.

The default implementation is a thin adapter over OpenAI-signed Codex Computer
Use and Chrome components. DevSpace dynamically discovers and verifies their
OpenAI code-signing identities, starts them through the signed Codex app-server
process boundary, forwards official permission requests, and returns screenshots
as MCP image content. It does not copy or reimplement their native desktop,
accessibility, DOM, Playwright, or Chrome extension engines.

The app-server client has a hard method allowlist: `initialize`,
`process/spawn`, `process/writeStdin`, and `process/kill`. Codex model APIs such
as `thread/start` and `turn/start` are rejected before transmission. Browser and
Computer Use request metadata is used only for local permission and interruption
scope.

The older Swift helper remains as `DEVSPACE_COMPUTER_USE_BACKEND=swift`, an
explicit rollback path. It is not selected automatically after any Codex adapter
failure and requires separate Screen Recording and Accessibility permission.

Computer and browser actions grant substantially more authority than
workspace-scoped file tools. The adapters preserve official application,
browser-origin, upload, download, sensitive-data, and interruption policies and
forward their elicitations to the connected MCP client. Native Computer Use
fails closed while macOS is locked unless the incoming request contains
authentic Codex `session_id` and `turn_id` metadata. DevSpace does not invent
those identifiers. Chrome Use is independent of desktop unlock and has been
validated while locked.

## Logs

By default, DevSpace logs requests and tool calls. Shell command previews are
disabled unless `DEVSPACE_LOG_SHELL_COMMANDS=1`.

Do not enable shell command logging if commands may contain secrets.

Artifact tool logs contain bounded workspace ID, validated hostname,
workspace-relative output path, byte count, hash, duration, and status metadata.
`download_artifact` does not log the opaque file value. Raw content, connector
references, native file IDs, bearer credentials, presigned URLs, host paths,
temporary paths, and base64 chunks are never included in tool logs or tool
results.

Local-control logs record the adapter, action type, whether an app, URL,
selector, coordinates, or text field was supplied, image count, duration, and
status. They exclude typed values, screenshot bytes, image base64 data,
request-metadata values, tab contents, and accessibility or DOM payloads.
