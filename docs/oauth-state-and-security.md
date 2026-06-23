# OAuth State, File Permissions, and URL Setup

This note documents how DevSpace stores OAuth state, why that state survives
server restarts, which values remain sensitive, and how the CLI chooses the
client-facing URL.

## Files And Directories

DevSpace uses two private locations by default:

```text
~/.devspace/
  config.json
  auth.json

~/.local/share/devspace/
  devspace.sqlite
  devspace.sqlite-wal
  devspace.sqlite-shm
```

`DEVSPACE_CONFIG_DIR` changes the first directory. `DEVSPACE_STATE_DIR` changes
the SQLite state directory.

On POSIX systems DevSpace enforces these permissions whenever it writes config
or opens the state database:

```text
~/.devspace                         0700
~/.devspace/config.json             0600
~/.devspace/auth.json               0600
~/.local/share/devspace             0700
devspace.sqlite                     0600
devspace.sqlite-wal                 0600
devspace.sqlite-shm                 0600
```

This also repairs permissions on files and directories that already exist.
Windows does not use these POSIX mode checks; filesystem ACLs control access
there.

## What Is Stored

### Configuration

`config.json` contains operational settings such as the bind host, port,
allowed project roots, and public base URL. It does not contain the Owner
password.

`auth.json` contains the Owner password. DevSpace needs the original value to
verify the password entered on its approval page, so this file is sensitive and
must remain private.

### OAuth clients

The `oauth_clients` SQLite table stores dynamically registered MCP client
metadata, including:

- generated `client_id`
- client name
- allowed redirect URIs
- grant and response types
- token endpoint authentication method
- registration timestamp

DevSpace accepts public OAuth clients only, advertises `none` as its token and
revocation endpoint authentication method, and strips client-secret fields
before persistence. This metadata is not an access token, but it can reveal
which client and redirect URI are configured.

### OAuth tokens

The `oauth_tokens` table stores:

- SHA-256 token hash
- access or refresh token type
- associated client ID
- scopes
- resource URL
- creation and expiration timestamps

Raw access and refresh token values are never written to SQLite. Tokens are
random 256-bit values, so a database reader cannot practically recover a token
from its SHA-256 hash. Expired token rows are removed when the OAuth store is
opened.

### Workspace state

The same SQLite database also contains workspace session metadata and loaded
agent-instruction snapshots. This can include local project paths and the
contents of loaded `AGENTS.md` or similar instruction files. The database
should therefore be treated as private even though OAuth tokens are hashed.

## Why Restarting Used To Break ChatGPT

ChatGPT can use dynamic client registration. It calls `/register` once, receives
a generated `client_id`, and reuses that ID for the app instance.

Older DevSpace builds stored the client registration and tokens only in memory.
Restarting the server erased them, while ChatGPT continued sending the old
`client_id`. DevSpace then returned:

```text
error: invalid_client
error_description: Invalid client_id
```

Current builds persist the registered client and hashed token state in SQLite.
The same client ID remains valid after a normal server restart.

When upgrading from an older in-memory build, remove and add the ChatGPT app one
final time. That creates a new client registration that can be persisted.

## Owner Password And Bearer Tokens

The Owner password is used only on the DevSpace approval page. It is not sent on
every MCP request.

After approval, DevSpace issues:

- a short-lived access token, one hour by default
- a longer-lived refresh token, 30 days by default

ChatGPT sends the access token as a bearer token and uses the refresh token to
obtain a new access token. Refresh tokens are rotated when used.

## URL Selection In `devspace init`

The setup flow offers:

```text
1. Localhost
2. Custom URL
```

Localhost automatically sets:

```text
http://localhost:<port>
```

Custom URL always opens a text input and waits for the user. The displayed URLs
are examples only. The user can enter a tunnel, reverse proxy, Tailscale, LAN,
or other reachable origin, for example:

```text
https://devspace.example.com
http://your-host:7676
```

The stored public base URL is an origin without `/mcp`. The URL configured in
ChatGPT must include the MCP path:

```text
https://devspace.example.com/mcp
```

The bind host and public URL are separate settings. A server may bind to
`100.64.0.2`, for example, while clients connect through an HTTPS domain.

## Logging

OAuth router requests retain their original path in request logs. Requests to
`/register`, `/authorize`, and `/token` should no longer appear incorrectly as
`/`.

Request logs do not intentionally include bearer tokens or the Owner password.
Avoid enabling shell-command logging when commands may contain secrets.

## Threat Boundaries

The permission and hashing changes reduce local disclosure risk, but they do
not make a compromised account safe:

- a process running as the same OS user can read private files
- root or an administrator can read the files
- malware in the user session can access the database and Owner password
- backups can copy sensitive configuration and workspace metadata
- an exposed shell tool has the permissions of the DevSpace OS user

Use a dedicated low-privilege OS account when stronger isolation is required.
Restrict tunnel access, keep allowed roots narrow, and protect backups.

## Dependency Audit

The production dependency tree is checked with:

```bash
npm audit --omit=dev
```

The security review updated `-works/pi-coding-agent` to `0.79.10`,
which resolves the reported `undici`, `protobufjs`, and `ws` advisories. This
secure dependency tree requires Node `>=22.19`.

## Verification Commands

Check paths and permissions:

```bash
devspace doctor
ls -ld ~/.devspace ~/.local/share/devspace
ls -l ~/.devspace/config.json ~/.devspace/auth.json
ls -l ~/.local/share/devspace/devspace.sqlite*
```

Expected POSIX permissions are `drwx------` for the directories and `-rw-------`
for the files.

Check connectivity:

```bash
curl http://127.0.0.1:7676/healthz
curl https://your-host.example.com/healthz
```

The MCP endpoint should reject unauthenticated requests with HTTP 401 and a
`WWW-Authenticate` header:

```bash
curl -i https://your-host.example.com/mcp
```

## Backup And Reset

Stop DevSpace before taking a simple file-level backup of the SQLite database,
or use an SQLite-aware backup method while it is running. Include the WAL file
if copying a live WAL-mode database.

Deleting the state database removes persisted workspace and OAuth state. After
such a reset, ChatGPT must register and authorize the app again. Deleting
`auth.json` removes the Owner password configuration and requires setup again.
