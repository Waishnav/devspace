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
npx @waishnav/devspace config get
npx @waishnav/devspace config set publicBaseUrl https://devspace.example.com
npx @waishnav/devspace config set requiredToolMode codex
npx @waishnav/devspace auth reset
```

## Core Environment Variables

| Variable | Purpose |
| --- | --- |
| `HOST` | Local bind host. Defaults to `127.0.0.1`. |
| `PORT` | Local port. Defaults to `7676`. |
| `DEVSPACE_ALLOWED_ROOTS` | Comma-separated local roots that workspaces may open. |
| `DEVSPACE_PUBLIC_BASE_URL` | Public origin for the server, without `/mcp`. |
| `DEVSPACE_ALLOWED_HOSTS` | Optional Host header allowlist override. |
| `DEVSPACE_OAUTH_OWNER_TOKEN` | Owner password for OAuth approval. Must be at least 16 characters. |
| `DEVSPACE_WORKTREE_ROOT` | Directory for managed Git worktrees. Defaults to `~/.devspace/worktrees`. |
| `DEVSPACE_STATE_DIR` | Directory for SQLite state. Defaults to `~/.local/share/devspace`. |

## Native Artifact Download

Native-file download is disabled by default. Enable it when ChatGPT needs to hand
an attached or generated file into an already-open workspace:

```bash
DEVSPACE_ARTIFACTS=1 npx @waishnav/devspace serve
```

This feature currently supports Linux. It is not registered on macOS, Windows,
or BSD because the secure publication path depends on traversable,
descriptor-anchored directory paths provided by Linux procfs.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEVSPACE_ARTIFACTS` | `0` | Expose `download_artifact` for trusted native files. |
| `DEVSPACE_ARTIFACT_MAX_FILE_BYTES` | `104857600` | Maximum streamed size of one file (100 MiB). |

The same settings may be persisted in `~/.devspace/config.json` as
`artifactsEnabled` and `artifactMaxFileBytes`.

`download_artifact` accepts the native file object supplied by the MCP connector,
a `workspaceId` returned by `open_workspace`, and a relative workspace `path`.
DevSpace safely creates missing parent directories, refuses to overwrite an
existing destination, and returns only the normalized workspace-relative path.
It does not accept conflict modes, expected hashes, arbitrary URL strings, local
paths, embedded credentials, or extra object fields.

There is no artifact root, total quota, TTL, pinning, persistent database record,
or background artifact cleanup service. See [Native File Exchange](artifact-exchange.md)
for the supported connector shape and security boundaries.

## macOS Computer Use

Desktop capture and input control are disabled by default:

```bash
DEVSPACE_COMPUTER_USE=1 npx @waishnav/devspace serve
```

The same setting may be persisted as `computerUseEnabled` in
`~/.devspace/config.json`.

The default backend is `codex`. It registers `computer_use` and `chrome_use`,
discovers the installed ChatGPT/Codex/plugin versions dynamically, verifies the
OpenAI code-signing identity, and proxies the signed local runtimes without
creating a Codex model thread or turn.

```bash
DEVSPACE_COMPUTER_USE_BACKEND=codex
```

Chrome Use defaults to the Chrome profile selected by
`chromeDefaultProfile` in `~/.devspace/config.json`; the environment override is
`DEVSPACE_CHROME_DEFAULT_PROFILE`. The selector may be a Chrome profile path,
profile name, or Google account email. The maintained deployment uses
`Default`. An explicit `chrome_use.profile` selection is sticky only for the
current ChatGPT conversation and does not change this machine default.

The legacy `swift` backend is an explicit rollback path only. It registers
`capture_screen`, `computer_action`, and the `read({ path: "@screen" })`
compatibility path and requires separate Screen Recording and Accessibility
permission for DevSpace. It is never selected automatically after a Codex
runtime failure.

```bash
DEVSPACE_COMPUTER_USE_BACKEND=swift
```

`DEVSPACE_CODEX_APP_PATH` can override ChatGPT.app discovery for diagnostics.
`DEVSPACE_CODEX_SKIP_SIGNATURE_CHECK=1` exists only for isolated development
and must not be used in the maintained deployment. Screenshot payloads continue
to use `DEVSPACE_ARTIFACT_MAX_FILE_BYTES`.

See [Local Multimodal Files, Computer Use, and Chrome Use](computer-use.md) for
the target architecture, routing policy, lock-screen behavior, and acceptance
matrix.

## OAuth

DevSpace uses a single-user OAuth approval flow.

Only the most recently approved MCP client remains authorized. A successful
Owner-password approval revokes older client registrations and tokens. Run
`devspace auth reset` to revoke the current client immediately.

| Variable | Default |
| --- | --- |
| `DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` |
| `DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` |
| `DEVSPACE_OAUTH_SCOPES` | `devspace` |
| `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` | `chatgpt.com,localhost,127.0.0.1` |
| `DEVSPACE_COMPUTER_USE` | `0` unless persisted locally |
| `DEVSPACE_COMPUTER_USE_BACKEND` | `codex` |
| `DEVSPACE_CHROME_DEFAULT_PROFILE` | `Default` |
| `DEVSPACE_CODEX_APP_PATH` | `/Applications/ChatGPT.app` discovery candidate |
| `DEVSPACE_CLOUDFLARED_PROTOCOL` | `http2` in the maintained service helper |

MCP clients discover metadata from:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

## Tool Modes

`DEVSPACE_TOOL_MODE` controls the tool surface.

| Value | Behavior |
| --- | --- |
| `minimal` | Default. Exposes `open_workspace`, `read`, `write`, `edit`, and `bash`. Clients use `bash` with tools such as `rg`, `find`, and `ls` for inspection. |
| `full` | Exposes the minimal tools plus dedicated `grep`, `glob`, and `ls` tools. |
| `codex` | Exposes the compact coding-agent surface: `open_workspace`, `read`, `apply_patch`, `exec_command`, and `write_stdin`. Existing mutation and shell tools are hidden. Upstream still treats this as opt-in; the maintained ChatGPT deployment uses it after local acceptance. |

A deployment may persist `requiredToolMode` in `~/.devspace/config.json` to lock
its tool contract. When set, the persisted value becomes the default and any
conflicting `DEVSPACE_TOOL_MODE` or `DEVSPACE_MINIMAL_TOOLS` request is rejected
before the server starts listening. This is intended for stable MCP endpoints
whose client-side schema may remain cached across backend restarts.

```bash
npx @waishnav/devspace config set requiredToolMode codex
```

Use `null` to remove the lock for a different deployment profile. Do not clear
the lock merely to run a diagnostic on the same production endpoint; use a
separate `DEVSPACE_CONFIG_DIR` instead.

`DEVSPACE_MINIMAL_TOOLS` remains a backward-compatible alias when
`DEVSPACE_TOOL_MODE` is unset: `1` selects `minimal` and `0` selects `full`.
The `codex` mode must be selected through `DEVSPACE_TOOL_MODE` and always uses
its fixed short tool names regardless of `DEVSPACE_TOOL_NAMING`.

Codex-mode commands run without a PTY by default. Set `tty: true` on
`exec_command` for interactive terminal programs. PTY support uses the optional
`node-pty` dependency; `write_stdin` can send input, poll output, and resize PTY
sessions.

The maintained two-host ChatGPT deployment pins `codex` in
`scripts/devspace-service.sh` and persists `requiredToolMode=codex`. `minimal`
remains an isolated diagnostic mode, not the normal production surface. With
`DEVSPACE_WIDGETS=changes`, `DEVSPACE_ARTIFACTS=1`, and the Codex computer-use
backend enabled, the expected local extensions remain available alongside the
five core coding tools: `show_changes`, `export_file`, `computer_use`, and
`chrome_use`.

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
| `DEVSPACE_SUBAGENTS` | Set to `1` to expose configured agent profiles as Subagents. Experimental and disabled by default. |
| `DEVSPACE_AGENT_DIR` | Defaults to `~/.codex`; its `skills` child is loaded for compatibility. |
| `DEVSPACE_SKILL_PATHS` | Optional comma-separated additional skill directories. |

DevSpace discovers standard Agent Skills from:

- `~/.agents/skills`
- project `.agents/skills`
- `~/.devspace/skills`

It also keeps compatibility with:

- the bundled `subagent-delegation` skill when `DEVSPACE_SUBAGENTS=1`, unless `~/.devspace/skills/subagent-delegation/SKILL.md` exists
- `DEVSPACE_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `DEVSPACE_SKILL_PATHS`

When Subagents are enabled, DevSpace discovers agent profiles
from:

- `~/.devspace/agents/*.md`
- project `.devspace/agents/*.md`

`open_workspace` returns a compact catalog containing profile names,
descriptions, providers, and optional models/thinking levels so the host model can choose an
agent without reading provider-specific launch details. `devspace agents ls`
lists existing subagent sessions for the current workspace, scoped by the
workspace environment injected into shell commands. The `subagent-delegation`
skill teaches the model to use only the minimal `devspace agents ls`,
`devspace agents run`, and `devspace agents show` workflow.

Starter profile templates are available under `examples/agents/`. Copy or adapt
them into one of the active profile directories before use.

Legacy project paths such as `.pi/skills` can be added through `DEVSPACE_SKILL_PATHS` when needed.

Example:

```bash
DEVSPACE_SKILL_PATHS="$HOME/.claude/skills,$HOME/company/skills" \
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
DEVSPACE_ARTIFACTS="1" \
DEVSPACE_TOOL_MODE="minimal" \
DEVSPACE_WIDGETS="full" \
npx @waishnav/devspace serve
```

The environment assignments must be part of the same command invocation, or
exported first.
