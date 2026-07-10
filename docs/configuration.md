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

## OAuth

DevSpace uses a single-user OAuth approval flow.

| Variable | Default |
| --- | --- |
| `DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` |
| `DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` |
| `DEVSPACE_OAUTH_SCOPES` | `devspace` |
| `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` | `chatgpt.com,localhost,127.0.0.1` |

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
| `codex` | Experimental. Exposes `open_workspace`, `read`, `apply_patch`, `exec_command`, and `write_stdin`. Existing mutation and shell tools are hidden. |

`DEVSPACE_MINIMAL_TOOLS` remains a backward-compatible alias when
`DEVSPACE_TOOL_MODE` is unset: `1` selects `minimal` and `0` selects `full`.
The `codex` mode must be selected through `DEVSPACE_TOOL_MODE` and always uses
its fixed short tool names regardless of `DEVSPACE_TOOL_NAMING`.

Codex-mode commands run without a PTY by default. Set `tty: true` on
`exec_command` for interactive terminal programs. PTY support uses the optional
`node-pty` dependency; `write_stdin` can send input, poll output, and resize PTY
sessions.

## Widgets

`DEVSPACE_WIDGETS` controls ChatGPT Apps iframe usage.

| Value | Behavior |
| --- | --- |
| `full` | Widget UI is attached to exposed workspace, file, edit, and shell tools. This is the default when full workspace payloads are selected. |
| `changes` | Enables the aggregate `show_changes` tool and attaches widget UI to `open_workspace` and `show_changes`. |
| `off` | Disables widget UI. This is the default in compact mode. |

## Compact payloads and execution-cost estimates

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEVSPACE_OPEN_WORKSPACE_PAYLOAD` | `compact` | Use `compact` for bounded instruction excerpts and smaller skill metadata, or `full` for the v1.0 payload. |
| `DEVSPACE_OPEN_WORKSPACE_INSTRUCTION_CHARS` | `6000` | Maximum characters returned per instruction excerpt; minimum `256`. |
| `DEVSPACE_USAGE_CONTENT` | `compact` | Append `compact` or `full` execution-cost summaries to tool output, or use `off` to hide them. |
| `DEVSPACE_USAGE_HISTORY` | `~/.local/share/devspace/usage-history.jsonl` | Local JSONL destination for non-blocking execution diagnostics. |

Execution diagnostics record observed server duration, Tool call count, error count, retry count,
input/output character volume, and text-token estimates. Token counts are estimates from text handled
by DevSpace, not host-model billing or actual model usage. Run `devspace-runtime costs` through
the existing Bash Tool for the current server-process aggregate.

## DevSpace v1.1 feature flags

All v1.1 feature flags default to `0`, so the existing compact Tool catalog and Fast Path remain unchanged.

| Variable | Enables |
| --- | --- |
| `DEVSPACE_SKILL_MATCHER` | `match_skills`, which ranks bounded Skill metadata without loading bodies. |
| `DEVSPACE_COMPOUND_TOOLS` | `project_snapshot`, `focused_context`, and read-only `review_changes`. |
| `DEVSPACE_BUILTIN_PROFILES` | Built-in `explore`, `implement`, `review`, and `design` profiles when Subagents are enabled. |
| `DEVSPACE_DESIGN_AUDIT` | The guarded `design_audit` adapter and three bundled Design Skills. |
| `DEVSPACE_DESIGN_AUDIT_ALLOWED_HOSTS` | Comma-separated exact hosts/origins; defaults to loopback hosts only. |

Feature flag values are strict: `1/0`, `true/false`, `yes/no`, and `on/off` are accepted.
New Tool results include `serverDurationMs`, `payloadCharacters`, `returnedItems`, and `truncated`.

## Runtime reliability commands

Runtime diagnostics are integrated into the existing Bash Tool instead of increasing the model-facing
MCP Tool catalog. These exact commands are intercepted by DevSpace and do not start a login shell:

| Bash command | Purpose |
| --- | --- |
| `devspace-runtime diagnose [--github] [command ...]` | Classifies workspace access, Git detection, executable discovery, safe PATH fallbacks, and optional GitHub CLI authentication without returning credentials. |
| `devspace-runtime smoke` | Runs bounded read-only checks for list/read/search, shell PATH resolution, Git, and MCP App resources. |
| `devspace-runtime costs` | Returns observed duration, calls, errors, retries, character volume, and estimated text tokens from the current server process. |
| `devspace-runtime finder <path>` | On macOS, opens a validated workspace directory or reveals a validated file in Finder after an explicit request. |

Shell execution augments the inherited PATH with existing standard locations such as
`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, and system binary directories. It does not
source `.zshrc`, `.zprofile`, or another login-shell configuration, avoiding startup side effects.

When Widgets are enabled, Tool cards with a workspace path display a link-style **Open in Finder**
action. The App calls the app-only `open_in_finder` Tool; it is hidden from the model-facing catalog.
The server validates the path against the workspace before invoking macOS Finder. Paths outside the
approved workspace are rejected by the normal root guard.

For a quick regression check after a host-model rollout, run `devspace-runtime smoke` through Bash or:

```bash
npm run test:runtime
```

The v1.1 package intentionally ships Design Audit as an adapter only: no Playwright/CDP/axe
runtime is currently bundled, no browser binary is downloaded, and an enabled Tool returns an
unavailable error until a real adapter is connected. A future adapter must use an ephemeral
browser, validate redirects and subresources against the same URL policy, avoid cookies, write
artifacts only inside the requested workspace directory, and terminate the browser in `finally`.

Skills may optionally declare bounded `short-description`, `triggers`, and `required-tools`
frontmatter for matching. Existing `name` and `description` metadata remains fully compatible;
only a selected Skill is activated by reading its `SKILL.md`.

## Approved shell aliases

`DEVSPACE_APPROVED_SHELL_COMMANDS_FILE` may point to a local JSON file. The
default is `~/.devspace/approved-shell-commands.json`. An alias is invoked as
`devspace-approved <alias>` and is accepted only when its configured
`workspaceRoot` exactly matches the open workspace. Its optional
`workingDirectory` must remain inside that root.

```json
{
  "commands": [
    {
      "alias": "verify",
      "workspaceRoot": "/absolute/project/path",
      "workingDirectory": ".",
      "command": "npm test"
    }
  ]
}
```

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
DEVSPACE_TOOL_MODE="minimal" \
DEVSPACE_WIDGETS="full" \
npx @waishnav/devspace serve
```

The environment assignments must be part of the same command invocation, or
exported first.
