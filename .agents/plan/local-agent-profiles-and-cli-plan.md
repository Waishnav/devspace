# Subagent profiles and DevSpace agent CLI plan

## Decision

Subagent profiles describe roles over built-in coding-agent providers.
DevSpace owns provider invocation and lifecycle. Custom CLI-backed agents,
provider action objects, and model-visible backend details are out of scope for
v1.

The model-facing workflow stays small:

```bash
devspace agents ls
devspace agents run <profile-or-id> "<prompt>"
devspace agents show <id>
```

Profile discovery happens through the compact catalog returned by
`open_workspace`. `devspace agents ls` lists existing subagent sessions for the
current workspace; it does not list profile definitions.

## Profile schema

Profiles are discovered from:

- `~/.devspace/agents/*.md`
- project `.devspace/agents/*.md`

Supported frontmatter fields:

```yaml
schema: devspace-agent/v1
name: reviewer
description: Read-only reviewer for bugs, security risks, and missing tests.
provider: codex
model: gpt-5.4
disabled: false
```

Supported providers:

- `codex`
- `claude`
- `opencode`
- `pi`
- `cursor`
- `copilot`

Removed from v1 profile schema:

- `backend`
- `command`
- `mode`
- `permissions`
- `actions`

## Provider mapping

DevSpace maps provider ids to native integrations:

- `codex`: Codex SDK
- `claude`: Claude Code SDK
- `opencode`: OpenCode SDK
- `pi`: Pi RPC mode
- `cursor`: ACP
- `copilot`: ACP

The adapter registry is the internal seam future MCP tools can reuse if we move
from skill plus CLI guidance to first-class MCP agent tools.

## Model exposure

`open_workspace` exposes only compact profile metadata:

```json
{
  "name": "reviewer",
  "description": "Read-only reviewer for bugs, security risks, and missing tests.",
  "provider": "codex",
  "model": "gpt-5.4"
}
```

The profile body, provider protocol, raw provider transcript, and adapter
details stay outside the default model context.

Shell calls launched through DevSpace receive `DEVSPACE_WORKSPACE_ID` and
`DEVSPACE_WORKSPACE_ROOT`, so `devspace agents ls` can scope itself without the
model passing workspace flags.

## Non-goals

- Custom or arbitrary subagent commands.
- Provider-specific action DSLs.
- Exposing raw provider transcripts by default.
- Tracking changed files or tests from provider output.
