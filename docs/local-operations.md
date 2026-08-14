# Local Operations Guide

This file documents the local DevSpace installation on a Mac. It supplements
the upstream documentation and must never contain the Owner password, OAuth
tokens, tunnel credentials, or an active tunnel URL.

## Local Installation

- CLI: `/opt/homebrew/bin/devspace`
- Global npm package: `/opt/homebrew/lib/node_modules/@waishnav/devspace`
- Persistent configuration: `~/.devspace/config.json`
- Owner password storage: `~/.devspace/auth.json` (private; do not commit)
- Runtime state: `~/.local/share/devspace/`
- Default local MCP endpoint: `http://127.0.0.1:7676/mcp`

## Current Local Policy

For example, a workspace allowlist can be `/Users/you`. DevSpace can open projects
under this home directory. This is intentionally broader than the initial
single-directory verification setup and should be reviewed before connecting a
different or untrusted ChatGPT account.

Check the installed version and resolved configuration:

```bash
devspace --version
devspace doctor
```

## Start A Named-Tunnel Connection

Keep the service bound to localhost and configure a named Cloudflare Tunnel in
`~/.cloudflared/config.yml`. Start both processes only while access is needed:

```bash
./scripts/devspace-service.sh start
./scripts/devspace-service.sh status
```

The helper creates a `devspace-service` tmux session with a `server` window and
a `tunnel` window. Inspect or take over the raw processes with:

```bash
tmux attach -t devspace-service
```

The equivalent manual commands are:

```bash
DEVSPACE_TOOL_MODE=codex DEVSPACE_WIDGETS=changes DEVSPACE_ARTIFACTS=1 DEVSPACE_COMPUTER_USE=1 DEVSPACE_COMPUTER_USE_BACKEND=codex devspace serve
cloudflared --config ~/.cloudflared/config.yml tunnel run --protocol http2
```

Logs are written to:

```text
~/Library/Logs/DevSpace/server.log
~/Library/Logs/DevSpace/tunnel.log
```

If `cloudflared` reports DNS timeouts through `100.100.100.100`, verify the
normal Wi-Fi resolver first. A working Wi-Fi resolver combined with a failing
`100.100.100.100` query means Tailscale MagicDNS is blocking tunnel discovery:

```bash
dig @100.100.100.100 region1.v2.argotunnel.com
dig @1.1.1.1 region1.v2.argotunnel.com
tailscale set --accept-dns=false
./scripts/devspace-service.sh start
```

This keeps Tailscale networking active while returning DNS control to macOS.
Restore Tailscale DNS later with `tailscale set --accept-dns=true` when needed.

In ChatGPT, create one custom plugin for this Mac using its fixed endpoint:

```text
https://<this-mac-subdomain>/mcp
```

Approve the OAuth page with the Owner password. Do not paste that password into
an AI chat or store it in this repository.

## Replace A ChatGPT Account

Each Mac keeps one valid ChatGPT OAuth client. Approving a plugin from a new
account automatically revokes the previous client and all of its tokens.

Revoke the old account before connecting a replacement when immediate removal
is required:

```bash
devspace auth reset
```

The public URL, tunnel, Owner password, allowed roots, and workspace state stay
unchanged.

## Add Another Mac

Use a different subdomain, named Tunnel, and ChatGPT plugin name for each Mac.
Perform the Cloudflare login, DNS route, and ChatGPT plugin creation manually.
Copy this repository for the shared helper and documentation, but create fresh
`~/.cloudflared` credentials, `~/.devspace/auth.json`, and OAuth state on every
computer.

Install and build the shared software:

```bash
brew install node cloudflared tmux
npm ci --include=dev
npm run build
npm install -g .
```

Create the machine-specific Tunnel and DNS record. Replace the example values
with a short unique machine name and its subdomain:

```bash
cloudflared tunnel login
cloudflared tunnel create devspace-work
cloudflared tunnel route dns devspace-work devspace-work.example.com
```

Create `~/.cloudflared/config.yml` with the Tunnel ID and credential path printed
by `cloudflared tunnel create`:

```yaml
tunnel: <tunnel-id>
credentials-file: /Users/<mac-user>/.cloudflared/<tunnel-id>.json
protocol: http2

ingress:
  - hostname: devspace-work.example.com
    service: http://127.0.0.1:7676
  - service: http_status:404
```

Run `devspace init` and set the matching public origin without `/mcp`. Start the
service, then create a ChatGPT plugin named for the Mac with the full MCP URL:

```text
https://devspace-work.example.com/mcp
```

Complete the Owner-password approval and call `open_workspace` once to verify
the tool and workspace template.

Validate the connection with a read-only request before allowing edits:

```text
Open the DevSpace workspace at <approved absolute path>, then run pwd and git
status. Do not modify files.
```

## Stop And Verify

Stop both processes with:

```bash
./scripts/devspace-service.sh stop
```

Confirm nothing remains exposed:

```bash
lsof -nP -iTCP:7676 -sTCP:LISTEN
ps aux | rg '[d]evspace|[c]loudflared'
```

No output from the first command means DevSpace is no longer listening on the
default port.

## Monitor Live Activity

The service writes DevSpace activity to
`~/Library/Logs/DevSpace/server.log` and tunnel health to
`~/Library/Logs/DevSpace/tunnel.log`. The directory and files are private to the
current macOS user.

Use the repository helper to watch just MCP sessions and tool calls:

```bash
./scripts/watch-live.sh
```

Other modes are:

```bash
./scripts/watch-live.sh server
./scripts/watch-live.sh tunnel
```

DevSpace logs tool name, workspace, path where applicable, outcome, and
duration. Full shell command previews remain disabled by default because
commands can contain secrets.

## Security Boundary

`allowedRoots` restricts which directories DevSpace can open as workspaces and
which files its workspace tools can address. It is not a full OS sandbox:
DevSpace shell commands run with the privileges of the local macOS user.

Do not expose DevSpace to untrusted accounts. Keep the allowed root narrow,
keep the Owner password private, and stop temporary tunnels after use.

## Related Upstream Documentation

- `docs/setup.md`: installation and connector setup
- `docs/configuration.md`: persisted config and environment variables
- `docs/security.md`: OAuth, tunnel, and shell-risk model
- `docs/gotchas.md`: callback, host, and tunnel troubleshooting
