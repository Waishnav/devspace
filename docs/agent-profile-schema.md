# Subagent profile schema

DevSpace agent profiles are user-owned markdown files with YAML
frontmatter. They describe roles such as reviewer, explorer, or implementer.
The internal on-demand `devspace-agentd` process owns provider invocation. The
CLI and MCP server use it as clients when they need agent execution.

When subagents are enabled, the internal `devspace-agentd` process owns the
durable agent manager and live provider runtimes. `devspace agents run` is a
thin local client that starts or reuses the daemon automatically; `devspace
serve` is not required. A run returns an agent id immediately, while the daemon
persists its status, latest response, and provider session id.

Profiles are discovered from:

- `~/.devspace/agents/*.md`
- `.devspace/agents/*.md`

Packaged files under `examples/agents/` are starter templates only.

## Minimal shape

```md
---
schema: devspace-agent/v1
name: reviewer
description: Read-only reviewer for bugs, security risks, and missing tests.
provider: codex
model: gpt-5.4
effort: high
disabled: false
---

You are a read-only reviewer. Do not edit files.
Focus on correctness, security, test gaps, and maintainability.
Cite files and return concise findings.
```

## Frontmatter fields

### `schema`

Optional schema identifier:

```yaml
schema: devspace-agent/v1
```

### `name`

Stable profile identifier shown to the model and accepted by:

```bash
devspace agents run <name> "<prompt>"
```

Use lowercase kebab-case names. If omitted, DevSpace uses the filename without
`.md`.

### `description`

Required short purpose. This is exposed by `open_workspace` so the supervising
model can choose the right profile.

### `provider`

Required built-in provider id:

```yaml
provider: codex
provider: claude
provider: opencode
provider: pi
provider: cursor
provider: copilot
provider: grok
```

Unsupported or custom providers are rejected. DevSpace maps providers to their
native integration:

- `codex`: the host-installed `codex app-server` command
- `claude`: Claude Code SDK
- `opencode`: OpenCode SDK
- `pi`: the installed Pi coding-agent SDK, one in-process session per DevSpace agent
- `cursor`: ACP
- `copilot`: ACP
- `grok`: Grok Build ACP (`grok agent stdio`)

Codex is resolved from the user's environment rather than bundled with
DevSpace. Run `codex login` normally before using it; set `CODEX_COMMAND` when
the executable is not on the normal PATH. OpenCode, Cursor, and Copilot
runtimes are started and reused by the daemon internally, while Pi is embedded
through its Node SDK.

### `model`

Optional provider model id or alias.

```yaml
model: gpt-5.4
model: sonnet
```

### `effort`

Optional provider reasoning effort, thinking level, or model variant. If omitted,
DevSpace lets the provider default apply. Values are provider-specific
passthrough strings; DevSpace does not translate names between harnesses.

```yaml
effort: low
effort: high
effort: xhigh
```

DevSpace passes this through to providers that expose a matching control:

- `claude`: SDK effort with adaptive thinking.
- `codex`: app-server model reasoning effort.
- `pi`: the AgentSession thinking-level control.
- `opencode`: model variant.
- `cursor` and `copilot`: ACP thought-level config when supported.
- `grok`: `--reasoning-effort` on startup and xAI's ACP model metadata for resumed sessions.

### `disabled`

Optional boolean. Disabled profiles are not exposed.

```yaml
disabled: true
```

## Markdown body

The body is the profile prompt prefix DevSpace prepends when launching that
profile. It is not included in `open_workspace` by default.

Recommended body content:

- When to use this profile.
- Whether the worker should act read-only or may make changes.
- Output format.
- Review or testing expectations.

## Model-facing workflow

The Subagent skill teaches only:

```bash
devspace agents ls --json
devspace agents targets --json
devspace agents run <profile-or-provider> "<prompt>" --json
devspace agents continue <id> "<prompt>" --json
devspace agents show <id> --json
```

`open_workspace` exposes compact profile metadata:

```json
{
  "name": "reviewer",
  "description": "Read-only reviewer for bugs, security risks, and missing tests.",
  "provider": "codex",
  "model": "gpt-5.4",
  "effort": "high"
}
```

`devspace agents targets` lists usable providers and profile definitions for the
current workspace. `devspace agents ls` lists existing subagent sessions; it does
not list profile definitions.

Use `devspace agents continue <id>` for a later turn. The logical agent ID is
the `agt_...` value returned by `run` or `ls`; provider session IDs are not
accepted as substitutes.

The full profile body stays out of the model context until DevSpace launches the
profile.

## Runtime lifecycle

DevSpace keeps provider sessions warm while they are active or recently used,
but persists only the provider session id and durable agent metadata. Native
sharing follows the provider boundary: Codex uses one app-server across agents,
OpenCode uses one server across sessions, ACP providers use one process across
sessions, while Claude and Pi keep one warm runtime per DevSpace agent. There is
one active turn per agent; different agents may run concurrently.

If the daemon restarts during a turn, persisted `starting` and `running` agents
become `error` with a restart message. The next `agents continue <id>` request can
continue the provider session when that provider supports resumption. The MCP
server can restart independently because it does not own this state.

## Current non-goals

- Custom or arbitrary CLI-backed agents.
- Inferring changed files, tests, or diffs from worker output.
- Exposing raw provider transcripts by default.
- Teaching the model provider-specific CLIs.
- First-class MCP agent tools. Future tools should call the same local agent
  daemon used by `devspace agents` rather than executing providers in the MCP
  server process.
