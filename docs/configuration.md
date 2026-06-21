# Configuration Reference

DevSpace can be configured through `devspace init`, persisted config files, or
environment variables.

The default files are:

```text
~/.devspace/config.json
~/.devspace/auth.json
```

Use another config directory with:

```bash
DEVSPACE_CONFIG_DIR=/path/to/config npx @waishnav/devspace serve
```

## Commands

```bash
npx @waishnav/devspace init
npx @waishnav/devspace serve
npx @waishnav/devspace doctor
npx @waishnav/devspace config show
npx @waishnav/devspace config port 7676
npx @waishnav/devspace config host 127.0.0.1
npx @waishnav/devspace config domain devspace.example.com
npx @waishnav/devspace config key
npx @waishnav/devspace workspace add ~/workspace/project-a --default
npx @waishnav/devspace workspace list
npx @waishnav/devspace service start
npx @waishnav/devspace service status
npx @waishnav/devspace service logs
npx @waishnav/devspace config get
```

## Configuration Management

The primary config commands are:

```bash
devspace config show
devspace config port 7676
devspace config host 127.0.0.1
devspace config domain devspace.example.com
devspace config key
```

`config port`, `config host`, `config domain`, and `config key` save the new
value immediately. If a managed DevSpace background service is currently
running, DevSpace automatically restarts it.

`config key` rotates the existing Owner password stored in `auth.json`,
invalidates saved OAuth approvals and tokens, and requires clients to
reauthorize.

`config show` reports the effective runtime values. Access keys are always
masked. If the active Owner password comes from `DEVSPACE_OAUTH_OWNER_TOKEN`,
DevSpace masks and shows that effective value.

## Workspace Management

Persisted workspace roots replace the old one-shot “roots only at init” flow:

```bash
devspace workspace add ~/workspace/project-a --default
devspace workspace add ~/workspace/project-b
devspace workspace list
devspace workspace remove ~/workspace/project-a
devspace workspace clear-default
```

Use temporary workspace overrides for one run:

```bash
devspace serve --add-dir ~/scratch/project-c --workspace ~/workspace/project-b
```

These workspace paths define the authorization boundary for DevSpace file tools.
If no workspace is configured and `DEVSPACE_ALLOWED_ROOTS` is unset, DevSpace
starts in a safe blocked state with no authorized workspace roots.

## Service Management

DevSpace only manages its own background service. `devspace service start`
installs the service on first use for the current platform, and starts it on
later runs:

```bash
devspace service start
devspace service status
devspace service restart
devspace service stop
devspace service disable
devspace service uninstall
devspace service logs
devspace service doctor
```

Platform behavior:

- Linux and Ubuntu use `systemctl --user` when user systemd is available.
- macOS uses a per-user LaunchAgent.
- Windows uses Task Scheduler.
- WSL uses user systemd when available and otherwise reports a Task Scheduler fallback.

DevSpace never auto-configures DNS, reverse proxies, TLS certificates, or
firewall rules.

## Core Environment Variables

| Variable | Purpose |
| --- | --- |
| `HOST` | Local bind host. Defaults to `127.0.0.1`. |
| `PORT` | Local port. Defaults to `7676`. |
| `DEVSPACE_ALLOWED_ROOTS` | Comma-separated local roots that workspaces may open. |
| `DEVSPACE_PUBLIC_BASE_URL` | Public origin for the server, without `/mcp`. |
| `DEVSPACE_MCP_PATH` | Optional MCP path override. Defaults to `/mcp`. |
| `DEVSPACE_TUNNEL` | Optional automatic tunnel mode. Currently supports `cloudflare` when explicitly enabled. |
| `DEVSPACE_ALLOWED_HOSTS` | Optional Host header allowlist override. |
| `DEVSPACE_OAUTH_OWNER_TOKEN` | Owner password for OAuth approval. Must be at least 16 characters. |
| `DEVSPACE_WORKTREE_ROOT` | Directory for managed Git worktrees. Defaults to `~/.devspace/worktrees`. |
| `DEVSPACE_STATE_DIR` | Directory for SQLite state. Defaults to `~/.local/share/devspace`. |
| `DEVSPACE_SESSION_WORKSPACE` | Temporary default workspace for the current `serve` run. |

When `DEVSPACE_ALLOWED_ROOTS` is omitted, DevSpace does not fall back to the
current working directory anymore. You must explicitly configure allowed roots
through `devspace workspace add ...` or this environment variable.

## OAuth

DevSpace uses a single-user OAuth approval flow.

| Variable | Default |
| --- | --- |
| `DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` |
| `DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` |
| `DEVSPACE_OAUTH_SCOPES` | `devspace` |
| `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` | `chatgpt.com,localhost,127.0.0.1` |
| `DEVSPACE_OAUTH_STATE_PATH` | `$DEVSPACE_STATE_DIR/oauth.json` |

Registered OAuth clients, token hashes, authorization code hashes, and approved
consents are persisted in SQLite at `$DEVSPACE_STATE_DIR/devspace.sqlite` by
default. `DEVSPACE_OAUTH_STATE_PATH` is kept as the legacy JSON state import
path; when an existing JSON file is present, DevSpace imports compatible clients,
token hashes, and consents into SQLite without storing raw tokens.

MCP clients discover metadata from:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

## Tool Modes

`DEVSPACE_TOOL_NAMING` controls tool names.

| Value | Behavior |
| --- | --- |
| `short` | Default. Uses `read`, `edit`, `bash`, and related names. |
| `legacy` | Uses `read_file`, `edit_file`, `run_shell`, and related names. |

`DEVSPACE_TOOL_MODE` controls the tool surface.

| Value | Behavior |
| --- | --- |
| `minimal` | Default. Disables dedicated search and list tools. Clients use the shell tool with `rg`, `grep`, `find`, `ls`, or `tree` for inspection. |
| `full` | Enables dedicated `grep`, `glob`, and `ls` tools. |

`DEVSPACE_SHELL_MODE` controls shell execution policy.

| Value | Behavior |
| --- | --- |
| `full` | Default. Preserves the current shell behavior. |
| `read-only` | Allows only single-command inspection workflows such as `rg`, `git status`, `find`, or `ls`. Blocks shell control operators and mutating commands. |
| `off` | Disables shell execution entirely. |

## Tunnel Modes

DevSpace keeps the existing manual `publicBaseUrl` flow by default. Automatic
Cloudflare quick tunnel mode is opt-in only.

Enable it explicitly with one of:

```bash
npx @waishnav/devspace serve --tunnel
DEVSPACE_TUNNEL=cloudflare npx @waishnav/devspace serve
```

Or set `"tunnel": "cloudflare"` in `~/.devspace/config.json`.

Use `--no-tunnel` to override configured tunnel mode for one run.

## Widgets

`DEVSPACE_WIDGETS` controls ChatGPT Apps iframe usage.

| Value | Behavior |
| --- | --- |
| `full` | Default. Widget UI is attached to exposed workspace, file, edit, and shell tools. |
| `changes` | Enables the aggregate `show_changes` tool and attaches widget UI to `open_workspace` and `show_changes`. |
| `off` | Disables widget UI. |

## Skills

| Variable | Purpose |
| --- | --- |
| `DEVSPACE_SKILLS` | Set to `0` to hide skills. Enabled by default. |
| `DEVSPACE_AGENT_DIR` | Defaults to `~/.codex`. |
| `DEVSPACE_SKILL_PATHS` | Optional comma-separated skill directories. |

Project skill layout:

- system built-in DevSpace skills
- `skills/local`: project skills meant to be committed
- `skills/installed`: user-installed project skills, typically git-ignored

ChatGPT Plus on the web cannot natively install or register Codex Skills. DevSpace provides the MCP-side skill installation, discovery, and resolution layer instead.

Manage installed skills with:

```bash
devspace skills install --repo openai/skills --path skills/.curated/research
devspace skills install --workspace /path/to/project --repo openai/skills --path skills/.curated/research
devspace skills list
devspace skills list --workspace /path/to/project
devspace skills remove research
devspace skills remove --workspace /path/to/project research

devspace skills install -g --repo openai/skills --path skills/.curated/research
devspace skills list -g
devspace skills remove -g research
```

Both `--repo/--path` and `--local-path` must point directly at one standard skill directory with `SKILL.md`. Plugin roots, command folders, and agent-rules directories are not valid install targets.

Example:

```bash
DEVSPACE_SKILL_PATHS="$HOME/.codex/skills,$HOME/.claude/skills" \
npx @waishnav/devspace serve
```

## Logging

| Variable | Default |
| --- | --- |
| `DEVSPACE_LOG_LEVEL` | `info` |
| `DEVSPACE_LOG_FORMAT` | `json` |
| `DEVSPACE_LOG_REQUESTS` | `1` |
| `DEVSPACE_LOG_ASSETS` | `0` |
| `DEVSPACE_LOG_TOOL_CALLS` | `1` |
| `DEVSPACE_LOG_SHELL_COMMANDS` | `0` |
| `DEVSPACE_TRUST_PROXY` | `0` |

Set `DEVSPACE_LOG_FORMAT=pretty` for local debugging.

Set `DEVSPACE_LOG_SHELL_COMMANDS=1` only when you intentionally want command
previews in logs.

## Env-Only Example

```bash
DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)" \
DEVSPACE_ALLOWED_ROOTS="$HOME/personal,$HOME/work" \
DEVSPACE_PUBLIC_BASE_URL="https://devspace.example.com" \
DEVSPACE_WORKTREE_ROOT="$HOME/.devspace/worktrees" \
DEVSPACE_TOOL_MODE="minimal" \
DEVSPACE_TOOL_NAMING="short" \
DEVSPACE_WIDGETS="full" \
npx @waishnav/devspace serve
```

The environment assignments must be part of the same command invocation, or
exported first.
