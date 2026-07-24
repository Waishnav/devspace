# Local Operations Guide

This file documents the local DevSpace installation on this Mac. It supplements
the upstream documentation and must never contain the Owner password, OAuth
tokens, or an active tunnel URL.

## Local Installation

- CLI: `/opt/homebrew/bin/devspace`
- Global npm package: `/opt/homebrew/lib/node_modules/@waishnav/devspace`
- Persistent configuration: `~/.devspace/config.json`
- Owner password storage: `~/.devspace/auth.json` (private; do not commit)
- Runtime state: `~/.local/share/devspace/`
- Default local MCP endpoint: `http://127.0.0.1:7676/mcp`

Check the installed version and resolved configuration:

```bash
devspace --version
devspace doctor
```

## Start A Temporary ChatGPT Connection

Keep the service bound to localhost. Use a tunnel only while it is needed.

Terminal 1:

```bash
cloudflared tunnel --url http://127.0.0.1:7676
```

Copy the generated public HTTPS origin, for example
`https://example.trycloudflare.com`.

Terminal 2:

```bash
DEVSPACE_PUBLIC_BASE_URL="https://example.trycloudflare.com" devspace serve
```

In ChatGPT, add a custom MCP connector with:

```text
https://example.trycloudflare.com/mcp
```

Approve the OAuth page with the Owner password. Do not paste that password into
an AI chat or store it in this repository.

The `trycloudflare.com` hostname changes every time. Always pass the new origin
through `DEVSPACE_PUBLIC_BASE_URL`; do not reuse a stale hostname from
`~/.devspace/config.json`.

## Connect A Second ChatGPT Account

For a trusted second personal account, the temporary flow above is sufficient.
The account receives the same DevSpace capability after the Owner-password
approval; DevSpace is not a multi-user authorization boundary.

Validate the connection with a read-only request before allowing edits:

```text
Open the DevSpace workspace at <approved absolute path>, then run pwd and git
status. Do not modify files.
```

For a long-lived or less-trusted account, run a separate DevSpace instance with
its own port, configuration directory, state directory, allowed project root,
and Owner password. Prefer a container or separate macOS user for that instance.

## Stop And Verify

Stop `devspace serve` and `cloudflared tunnel` with `Ctrl-C` in their terminals.

Confirm nothing remains exposed:

```bash
lsof -nP -iTCP:7676 -sTCP:LISTEN
ps aux | rg '[d]evspace|[c]loudflared'
```

No output from the first command means DevSpace is no longer listening on the
default port.

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
