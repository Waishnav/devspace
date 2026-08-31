# Configuration Reference

DevSpace stores durable settings in `~/.devspace/config.jsonc`. The file accepts
comments and trailing commas and is validated before the server starts. Editor
completion is provided by the versioned [JSON Schema](../schema/v1/devspace.schema.json),
also hosted at the URL in the file's `$schema` property.

Authentication stays separate because it contains a secret:

```text
~/.devspace/config.jsonc
~/.devspace/auth.json
```

Run `devspace init` to create both files. `devspace config set publicBaseUrl
<url|null>` updates the JSONC document without discarding its comments.

## Complete example

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/Waishnav/devspace/main/schema/v1/devspace.schema.json",
  "configVersion": 1,

  "server": {
    "host": "127.0.0.1",
    "port": 7676,
    "maxMcpSessions": 256,
    // Use the public origin only; do not append /mcp.
    "publicBaseUrl": "https://devspace.example.com",
    "allowedHosts": [],
    "trustProxy": false,
  },
  "workspaces": {
    "allowedRoots": ["~/personal", "~/work"],
    "worktreeRoot": "~/.devspace/worktrees",
  },
  "storage": {
    "stateDir": "~/.local/share/devspace",
  },
  "tools": {
    "mode": "codex",
  },
  "ui": {
    "enabled": true,
  },
  "artifacts": {
    "enabled": false,
    "maxFileBytes": 104857600,
  },
  "skills": {
    "enabled": true,
    "paths": [],
    "agentDir": "~/.codex",
  },
  "subagents": {
    "enabled": false,
    "providers": [],
  },
  "logging": {
    "level": "info",
    "format": "json",
    "requests": true,
    "assets": false,
    "toolCalls": true,
    "shellCommands": false,
  },
  "oauth": {
    "accessTokenTtlSeconds": 3600,
    "refreshTokenTtlSeconds": 2592000,
    "scopes": ["devspace"],
    "allowedRedirectHosts": ["chatgpt.com", "localhost", "127.0.0.1"],
  },
}
```

Omitted sections and keys use the defaults shown above. An empty
`workspaces.allowedRoots` uses the current working directory. Unknown keys are
rejected so spelling mistakes cannot silently alter behavior.

`server.maxMcpSessions` limits how many stateful MCP sessions DevSpace keeps in
memory. When the limit is reached, DevSpace closes the least-recently-used idle
session first. Active sessions are not evicted. If all retained sessions are
active, new initialize requests return `503` until a slot is free.

## Tool modes and UI

`tools.mode` accepts two values:

| Value | Tool surface |
| --- | --- |
| `codex` | Default. `open_workspace`, `read`, `apply_patch`, `exec_command`, `write_stdin`, and `show_changes`. |
| `claude` | `open_workspace`, `read`, `write`, `edit`, `bash`, and `show_changes`. |

The dedicated MCP tools `grep`, `glob`, and `ls` are not exposed. Each mode uses
its shell tool with programs such as `rg`, `find`, and `ls` when it needs those
operations.

DevSpace attaches Apps UI metadata only to `open_workspace` and `show_changes`.
This avoids rendering an iframe for every read, edit, search, or command call.
Setting `ui.enabled` to `false` removes the metadata but does not remove the
`show_changes` tool.

## Skills and subagents

DevSpace discovers standard Agent Skills from `~/.agents/skills`, project
`.agents/skills`, and `~/.devspace/skills`. It also checks
`skills.agentDir/skills` and each path in `skills.paths`. Relative custom paths
are resolved from the active workspace.

Subagent providers are explicit. Omitted providers are disabled:

```jsonc
{
  "configVersion": 1,
  "subagents": {
    "enabled": true,
    "providers": [
      {
        "id": "codex",
        "enabled": true,
        "model": "gpt-5.4",
        "effort": "high",
      },
      {
        "id": "claude",
        "enabled": true,
        "model": "sonnet",
      },
    ],
  },
}
```

Profiles are loaded from `~/.devspace/agents/*.md` and project
`.devspace/agents/*.md`. `devspace agents targets` prints the configured targets
available in the current workspace.

Provider executable discovery remains process-scoped. The supported overrides
are `CODEX_COMMAND`, `CODEX_HOME`, `CLAUDE_COMMAND`, `CURSOR_COMMAND`,
`COPILOT_COMMAND`, `GROK_COMMAND`, and `GROK_AGENT_PROFILE`. DevSpace does not
persist provider credentials.

## Native artifact download

Set `artifacts.enabled` to `true` when a host needs to save a native attached or
generated file into an open workspace. `artifacts.maxFileBytes` limits one
streamed file. The secure publication path is currently available only on
Linux; the tool is not registered on macOS, Windows, or BSD.

## Environment boundary

Only two user-facing DevSpace environment variables remain:

| Variable | Purpose |
| --- | --- |
| `DEVSPACE_CONFIG_DIR` | Bootstrap location for `config.jsonc`, `auth.json`, skills, and profiles. |
| `DEVSPACE_OAUTH_OWNER_TOKEN` | Optional secret override for the owner token stored in `auth.json`. |

Durable environment settings were removed in v1.1. Move existing deployment
values to these JSONC keys:

| Removed setting | JSONC key |
| --- | --- |
| `HOST`, `PORT` | `server.host`, `server.port` |
| `DEVSPACE_PUBLIC_BASE_URL` | `server.publicBaseUrl` |
| `DEVSPACE_ALLOWED_HOSTS` | `server.allowedHosts` |
| `DEVSPACE_TRUST_PROXY` | `server.trustProxy` |
| `DEVSPACE_ALLOWED_ROOTS` | `workspaces.allowedRoots` |
| `DEVSPACE_WORKTREE_ROOT` | `workspaces.worktreeRoot` |
| `DEVSPACE_STATE_DIR` | `storage.stateDir` |
| `DEVSPACE_TOOL_MODE`, `DEVSPACE_MINIMAL_TOOLS` | `tools.mode` |
| `DEVSPACE_WIDGETS` | `ui.enabled` |
| `DEVSPACE_ARTIFACTS` | `artifacts.enabled` |
| `DEVSPACE_ARTIFACT_MAX_FILE_BYTES` | `artifacts.maxFileBytes` |
| `DEVSPACE_SKILLS` | `skills.enabled` |
| `DEVSPACE_SKILL_PATHS` | `skills.paths` |
| `DEVSPACE_AGENT_DIR` | `skills.agentDir` |
| `DEVSPACE_SUBAGENTS` | `subagents.enabled` |
| `DEVSPACE_LOG_LEVEL` | `logging.level` |
| `DEVSPACE_LOG_FORMAT` | `logging.format` |
| `DEVSPACE_LOG_REQUESTS` | `logging.requests` |
| `DEVSPACE_LOG_ASSETS` | `logging.assets` |
| `DEVSPACE_LOG_TOOL_CALLS` | `logging.toolCalls` |
| `DEVSPACE_LOG_SHELL_COMMANDS` | `logging.shellCommands` |
| `DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `oauth.accessTokenTtlSeconds` |
| `DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `oauth.refreshTokenTtlSeconds` |
| `DEVSPACE_OAUTH_SCOPES` | `oauth.scopes` |
| `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` | `oauth.allowedRedirectHosts` |

These environment values are not read or auto-imported in v1.1. Environment is
process state, so there is no reliable file DevSpace can migrate on the user's
behalf.

## v1.0 file migration

The first v1.1 load performs one migration when `config.jsonc` is missing and
`config.json` exists:

1. Validate the old JSON document.
2. Translate its known fields into the versioned JSONC structure.
3. Write and validate a temporary `config.jsonc`.
4. Atomically publish it.
5. Rename the old file to `config.json.v1.0.bak`.

If `config.jsonc` exists, DevSpace never reads `config.json`. Invalid JSONC also
never falls back to the old file. Unsupported legacy keys stop migration with an
actionable error instead of being silently discarded.

The persisted fields map as follows:

| v1.0 JSON field | v1.1 JSONC key |
| --- | --- |
| `host`, `port` | `server.host`, `server.port` |
| `publicBaseUrl`, `allowedHosts` | `server.publicBaseUrl`, `server.allowedHosts` |
| `allowedRoots`, `worktreeRoot` | `workspaces.allowedRoots`, `workspaces.worktreeRoot` |
| `stateDir` | `storage.stateDir` |
| `artifactsEnabled`, `artifactMaxFileBytes` | `artifacts.enabled`, `artifacts.maxFileBytes` |
| `agentDir` | `skills.agentDir` |
| `subagents` | `subagents` |
| `tools.mode`, `ui.enabled` | unchanged nested keys |

`auth.json` is unchanged.
