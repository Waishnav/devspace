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

Required provider instance id. The default instance ids are:

```yaml
provider: codex
provider: claude
provider: opencode
provider: pi
provider: cursor
provider: copilot
provider: grok
```

Profiles may also reference named provider instances configured under
`subagents.providers`, such as `provider: codex-work`. Provider instances map
to one of these built-in driver integrations:

- `codex`: the host-installed `codex app-server` command
- `claude`: Claude Code SDK
- `opencode`: the host-installed OpenCode CLI; DevSpace probes its major version
  and uses the matching 1.x or 2.x protocol internally
- `pi`: Pi's normal `--mode rpc` CLI process. DevSpace preserves Pi's native
  auth, settings, extensions, skills, context files, and session store.
- `acp`: generic Agent Client Protocol integration. Cursor, Copilot, and Grok
  are default provider instances using this driver; other ACP agents can be
  configured without adding a DevSpace driver.

Codex and OpenCode are resolved from the user's environment rather than bundled
as executables. Run their normal login/setup flows before using them; set
`CODEX_COMMAND` when Codex is not on the normal PATH. OpenCode is discovered as
`opencode`, and DevSpace automatically routes OpenCode 1.x and 2.x to their
matching runtime implementations. OpenCode, Cursor, and Copilot runtimes are
started and reused by the daemon internally. Pi is launched in RPC mode and
uses its native persisted session file as DevSpace's continuation identity;
`PI_COMMAND` selects another Pi executable (otherwise `pi` on `PATH`, then the
bundled package). Pi 0.80.5 or newer is required for the `agent_settled` event.

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
- `pi`: RPC `set_thinking_level`.
- `opencode`: model variant.
- ACP: standard model/thought-level config when advertised by the agent. The
  Grok flavor also understands xAI's typed model metadata and startup effort.

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

The Subagent skill uses the default compact XML fragments:

```bash
devspace agents targets
devspace agents ls
devspace agents run <profile-or-provider> "<prompt>"
devspace agents continue <id> "<prompt>"
devspace agents show <id>
devspace agents wait <id>...
devspace agents events <id> [--follow]
```

The commands do not add a document-level wrapper. `targets`, `ls`, and `wait`
print one fragment per item and print nothing for an empty list. This keeps the
model-facing result small:

```xml
<provider name="codex" model="gpt-5.4" effort="high"/>
<profile name="reviewer" provider="codex">Read-only code review.</profile>
<agent id="agt_123" status="running" turn="trn_9f2c1a7b"/>
<agent id="agt_123" status="completed" turn="trn_9f2c1a7b">Review complete.</agent>
<agent id="agt_456" status="failed" turn="trn_0d41e6c2" code="PROVIDER_EXECUTION_ERROR" retryable="false">Claude agent turn failed.<cause>Claude returned an error result: usage limit reached</cause></agent>
<error code="AGENT_NOT_FOUND" retryable="false" agent-id="agt_missing">Subagent not found.</error>
```

`show` returns an immediate snapshot. `wait` accepts one or more agent IDs and
waits for all of their current work. It does not stream fragments as individual
agents finish. With `--timeout <seconds>`, it returns each unique agent in
first-seen order and marks unfinished work with `status="running"
wait="timeout"`.

Every turn has a DevSpace-owned `turn` id. A failed turn includes the
provider's own explanation in `<cause>`, redacted and truncated.

`events` prints the current turn's activity as normalized fragments, and
`--follow` keeps printing until the turn ends. `--turn <turn-id>` selects an
earlier turn:

```xml
<event seq="1" type="turn_started" turn="trn_9f2c1a7b" at="2026-10-26T10:00:00.000Z"/>
<event seq="2" type="tool_started" turn="trn_9f2c1a7b" tool="Bash">git status --short</event>
<event seq="3" type="tool_completed" turn="trn_9f2c1a7b" tool="Bash" status="completed">git status --short</event>
<event seq="4" type="message" turn="trn_9f2c1a7b">The tree is clean.</event>
<event seq="5" type="turn_completed" turn="trn_9f2c1a7b" status="completed" at="2026-10-26T10:00:09.000Z"/>
```

Providers that cannot stream (currently OpenCode) report only `turn_started`
and `turn_completed`. The daemon keeps at most 500 events and 256 KiB per turn,
keeps events for the 20 most recent turns of each agent, truncates messages and
tool summaries, and redacts common credential shapes. Tool summaries carry the
identifying argument (a command, path, or query), never the full input or output.

`--json` remains available for scripts that need it, but the bundled skill does
not request it. Prompts, provider session IDs, and workspace paths are absent
from both output formats.

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
