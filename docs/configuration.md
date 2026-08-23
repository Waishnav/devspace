# Configuration Reference

DevSpace v1.1 uses a versioned JSONC configuration file as its primary product
configuration:

```text
~/.devspace/config.jsonc
~/.devspace/auth.json
```

`config.jsonc` is human-editable, supports comments and trailing commas, and can
reference the checked-in JSON Schema for editor completion and validation.
`auth.json` remains separate so the OAuth owner password is not mixed into normal
product configuration.

Use another configuration directory with:

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

## JSONC configuration

`devspace init` writes the canonical v1 shape. Keep only values you intentionally
want to configure; omitted values use DevSpace defaults.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/Waishnav/devspace/refs/tags/v1.1.0/schema/devspace-config.schema.json",
  "version": 1,

  "server": {
    "host": "127.0.0.1",
    "port": 7676,
    "allowedRoots": [
      "~/personal",
      "~/work"
    ],
    "publicBaseUrl": "https://devspace.example.com"
  },

  "harness": {
    "kind": "claude-code",
    "inspection": "shell"
  },

  "presentation": {
    "mode": "inline"
  },

  "skills": {
    "enabled": true,
    "paths": []
  },

  "artifacts": {
    "enabled": false,
    "maxFileBytes": 104857600
  },

  "subagents": {
    "enabled": true,
    "providers": [
      {
        "id": "codex",
        "enabled": true,
        "model": "gpt-5.4",
        "effort": "high"
      }
    ]
  },

  "logging": {
    "level": "info",
    "format": "json"
  }
}
```

The published schema is generated from the same Zod codec used at runtime. A
test keeps the checked-in schema synchronized with that codec.

### Precedence

Configuration resolves in this order:

1. Environment overrides, when supplied.
2. `~/.devspace/config.jsonc`.
3. Legacy `~/.devspace/config.json`, when no JSONC file exists.
4. DevSpace defaults.

If both persisted files exist, `config.jsonc` is authoritative. DevSpace does
not rewrite configuration during `serve`. An intentional write such as
`devspace init --force` or `devspace config set ...` writes the canonical JSONC
file. Existing JSONC comments, formatting, and unknown future keys are preserved
where the edited value does not require replacing them.

Legacy `config.json` remains readable in v1.1. Its old flat fields are migrated
to the v1 model in memory. The legacy file is left untouched so merely starting
DevSpace never mutates user state.

## Coding harness

The harness controls the model-facing coding tool contract.

| Configuration | Exposed tools |
| --- | --- |
| `{ "kind": "claude-code", "inspection": "shell" }` | `open_workspace`, `read`, `write`, `edit`, `bash` |
| `{ "kind": "claude-code", "inspection": "dedicated" }` | Above plus `grep`, `glob`, `ls` |
| `{ "kind": "codex" }` | `open_workspace`, `read`, `apply_patch`, `exec_command`, `write_stdin` |

The Claude Code harness uses the same mutation/shell contract as the previous
`minimal` and `full` tool modes. `inspection: "shell"` keeps inspection inside
`bash`; `inspection: "dedicated"` exposes dedicated search and directory tools.

The Codex harness uses process sessions. Commands run without a PTY by default;
set `tty: true` on `exec_command` for interactive terminal programs.

For compatibility, `DEVSPACE_TOOL_MODE=minimal|full|codex` still overrides the
persisted harness. `DEVSPACE_MINIMAL_TOOLS` remains an older alias when
`DEVSPACE_TOOL_MODE` is unset.

## Presentation and change review

`presentation.mode` controls host-rendered UI and the aggregate review workflow.

| Value | Behavior |
| --- | --- |
| `inline` | Default. Attach widget UI to normal exposed tools. |
| `change-review` | Expose `show_changes`, attach UI to `open_workspace` and `show_changes`, and track review checkpoints. |
| `off` | Do not attach widget UI. |

`DEVSPACE_WIDGETS=full|changes|off` remains a compatibility override mapping to
`inline|change-review|off` respectively.

## Server

The `server` object supports:

| Key | Default | Purpose |
| --- | --- | --- |
| `host` | `127.0.0.1` | Local bind host. |
| `port` | `7676` | Local MCP port. |
| `allowedRoots` | current directory | Local roots workspaces may open. |
| `publicBaseUrl` | local server URL | Public origin, without `/mcp`. Use `null` to fall back to the local URL. |
| `allowedHosts` | derived | Optional Host header allowlist. |
| `worktreeRoot` | `~/.devspace/worktrees` | Managed Git worktree directory. |
| `stateDir` | `~/.local/share/devspace` | SQLite state directory. |

`HOST`, `PORT`, `DEVSPACE_ALLOWED_ROOTS`, `DEVSPACE_PUBLIC_BASE_URL`,
`DEVSPACE_ALLOWED_HOSTS`, `DEVSPACE_WORKTREE_ROOT`, and `DEVSPACE_STATE_DIR`
remain deployment overrides.

## Native artifact download

Native-file download is disabled by default:

```jsonc
{
  "version": 1,
  "artifacts": {
    "enabled": true,
    "maxFileBytes": 104857600
  }
}
```

This feature currently supports Linux. It is not registered on unsupported
platforms even when requested in configuration. Runtime compilation resolves
that availability once so tool registration, model instructions, and startup
status agree.

`DEVSPACE_ARTIFACTS` and `DEVSPACE_ARTIFACT_MAX_FILE_BYTES` remain environment
overrides. See [Native File Download](artifact-exchange.md) for the connector and
security contract.

## Skills and subagents

Skills are enabled by default. Additional paths and the compatibility agent
directory can be persisted under `skills`:

```jsonc
{
  "version": 1,
  "skills": {
    "enabled": true,
    "paths": ["~/.claude/skills", "~/company/skills"],
    "agentDir": "~/.codex"
  }
}
```

DevSpace discovers standard Agent Skills from `~/.agents/skills`, project
`.agents/skills`, `~/.devspace/skills`, the compatibility agent directory, and
the configured additional paths.

When Subagents are enabled, agent profiles are discovered from
`~/.devspace/agents/*.md` and project `.devspace/agents/*.md`. Each provider entry
controls enablement plus optional `model` and `effort` defaults. Invocation
overrides win over profile values, which win over provider defaults.

The legacy boolean `"subagents": true` in `config.json` remains readable and is
migrated in memory to the explicit provider configuration. New JSONC config uses
the object form.

Provider availability is runtime state and never rewrites configuration.
Credentials remain owned by provider CLIs. For example, Grok Build uses
`grok login` or `XAI_API_KEY`; command-location variables such as `GROK_COMMAND`
and `CODEX_COMMAND` remain process/provider overrides rather than DevSpace
credentials.

`DEVSPACE_SKILLS`, `DEVSPACE_SKILL_PATHS`, `DEVSPACE_AGENT_DIR`, and
`DEVSPACE_SUBAGENTS` remain compatibility overrides.

## OAuth and secrets

The OAuth owner password stays in `~/.devspace/auth.json` or
`DEVSPACE_OAUTH_OWNER_TOKEN`; it is intentionally not part of `config.jsonc`.

Non-secret OAuth policy can be persisted:

```jsonc
{
  "version": 1,
  "oauth": {
    "accessTokenTtlSeconds": 3600,
    "refreshTokenTtlSeconds": 2592000,
    "scopes": ["devspace"],
    "allowedRedirectHosts": ["chatgpt.com", "localhost", "127.0.0.1"]
  }
}
```

The matching `DEVSPACE_OAUTH_*` variables remain environment overrides.

MCP clients discover metadata from:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

## Logging

Logging can be persisted under `logging`; environment variables continue to
override individual values.

| Key / override | Default |
| --- | --- |
| `level` / `DEVSPACE_LOG_LEVEL` | `info` |
| `format` / `DEVSPACE_LOG_FORMAT` | `json` |
| `requests` / `DEVSPACE_LOG_REQUESTS` | `true` |
| `assets` / `DEVSPACE_LOG_ASSETS` | `false` |
| `toolCalls` / `DEVSPACE_LOG_TOOL_CALLS` | `true` |
| `shellCommands` / `DEVSPACE_LOG_SHELL_COMMANDS` | `false` |
| `trustProxy` / `DEVSPACE_TRUST_PROXY` | `false` |

Enable shell command logging only when command previews are intentionally safe
to retain.

## Environment-only deployment

JSONC is the normal persistent interface, but fully environment-driven
deployments remain supported. `DEVSPACE_CONFIG_DIR` is always environment-only
because it locates the configuration itself. Secrets, child-process workspace
context (`DEVSPACE_WORKSPACE_ID`, `DEVSPACE_WORKSPACE_ROOT`), and internal daemon
controls also remain outside the persisted product config.
