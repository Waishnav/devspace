# Local agent profile schema

DevSpace local agent profiles are user-owned markdown files with YAML front matter.
They describe how a local coding-agent CLI can be used as a worker under ChatGPT
supervision.

The packaged files in `examples/agents/` are starter templates only. DevSpace does
not currently parse, load, activate, or run local agent profile definitions. A
future profile loader can define the user-owned directory for active profiles.

## Minimal shape

```md
---
schema: devspace-agent/v1
name: codex-explorer
description: Read-only Codex agent for bounded codebase questions.
provider: codex
backend: cli

capabilities:
  read: true
  write: false
  shell: false
  background: true
  resume: true

workspace:
  default: current
  isolation: none
  writeMode: read_only

actions:
  start:
    command: codex
    args:
      - exec
      - --json
      - -C
      - "{workspace}"
      - "{prompt}"
    background: true
    output: jsonl

  followup:
    strategy: resume_command
    command: codex
    args:
      - exec
      - resume
      - "{externalSessionId}"
      - --json
      - "{prompt}"

  read:
    strategy: devspace_process_poll

  cancel:
    strategy: devspace_process_signal
    signal: SIGINT

  diff:
    strategy: none

safety:
  requireExplicitUserIntent: true
  allowWrites: false
  requireReviewBeforeFinal: true
---

Use this agent for bounded read-only codebase investigation.
```

## Front matter fields

### `schema`

Required schema identifier.

Current value:

```yaml
schema: devspace-agent/v1
```

### `name`

Stable profile identifier shown to the model and user.

Use lowercase kebab-case names, for example:

```yaml
name: codex-explorer
```

### `description`

Short human-readable purpose. This should help the supervising model decide when
the agent is appropriate.

### `provider`

The local agent family or CLI provider.

Examples:

```yaml
provider: codex
provider: claude
provider: opencode
provider: cursor
provider: pi
provider: copilot
```

### `backend`

Execution backend. The near-term templates use CLI-backed agents:

```yaml
backend: cli
```

Future profiles may support protocol-backed backends such as ACP without changing
the high-level profile name.

## Capabilities

Capabilities describe what the worker is allowed or expected to do.

```yaml
capabilities:
  read: true
  write: false
  shell: false
  background: true
  resume: true
```

- `read`: the agent can inspect project files.
- `write`: the agent may modify files.
- `shell`: the agent may run shell commands.
- `background`: the agent can be started as a long-running process.
- `resume`: the agent supports follow-up prompts against an existing session.

These fields are descriptive in the current template-only stage. A future parser
should validate them before rendering an available-agent catalog or exposing
runtime tools.

## Workspace policy

```yaml
workspace:
  default: current
  isolation: user_decides
  writeMode: allowed
```

- `default`: default workspace source. Current templates use `current`.
- `isolation`: whether to use the same checkout, a branch, a worktree, or let the
  user decide.
- `writeMode`: whether writes are allowed.

Recommended values:

```yaml
isolation: none
isolation: user_decides

writeMode: read_only
writeMode: allowed
```

Use read-only profiles for review, lookup, and second opinions. Use write-capable
profiles only when the user explicitly asks a local agent to implement or edit.

## Actions

Actions define lifecycle commands and strategies.

### `actions.start`

Starts the local agent.

```yaml
actions:
  start:
    command: codex
    args:
      - exec
      - --json
      - -C
      - "{workspace}"
      - "{prompt}"
    background: true
    output: jsonl
```

Use `command` plus `args` arrays. Do not use free-form shell strings.

Good:

```yaml
command: codex
args:
  - exec
  - --json
  - -C
  - "{workspace}"
  - "{prompt}"
```

Avoid:

```yaml
run: "codex exec --json -C {workspace} {prompt}"
```

Argv arrays are easier to validate, escape, log, review, and migrate to future
backends.

### `actions.followup`

Defines how to continue a previous worker session.

Supported strategy names used by the starter templates:

```yaml
strategy: resume_command
strategy: fresh_prompt_with_context
```

Use `resume_command` when the provider has an explicit resume/session flag. Use
`fresh_prompt_with_context` when follow-up work must include previous summaries,
review findings, and diff context in a new prompt.

### `actions.read`

Defines how DevSpace should read worker output.

The starter templates use:

```yaml
read:
  strategy: devspace_process_poll
```

### `actions.cancel`

Defines how DevSpace should interrupt a running worker.

The starter templates use:

```yaml
cancel:
  strategy: devspace_process_signal
  signal: SIGINT
```

Prefer interruption over deleting provider session history.

### `actions.diff`

Defines how DevSpace can inspect worker file changes.

Read-only profiles should use:

```yaml
diff:
  strategy: none
```

Write-capable profiles should use:

```yaml
diff:
  strategy: git_diff
```

## Placeholders

The examples use placeholders that a future runtime can substitute safely:

```text
{workspace}
{prompt}
{externalSessionId}
```

- `{workspace}`: absolute workspace path selected by DevSpace or the user.
- `{prompt}`: focused worker prompt created by the supervising model.
- `{externalSessionId}`: provider session id returned by a previous agent run.

## Safety policy

```yaml
safety:
  requireExplicitUserIntent: true
  allowWrites: false
  requireReviewBeforeFinal: true
```

Recommended write-capable profile safety:

```yaml
safety:
  requireExplicitUserIntent: true
  allowWrites: true
  requireDiffReview: true
  requireTestsOrExplanation: true
```

Profiles should make user intent and review requirements explicit. DevSpace should
not silently delegate work to local agents, and the supervising model should not
present worker output as verified until it has reviewed the result.

## Markdown body

The markdown body should explain when to use the agent and provide a worker prompt
template.

Recommended sections:

- `Use this agent when ...`
- `Good tasks:`
- `Worker prompt style:`
- A final report format that the supervising model can review.

The body is model-facing guidance. Keep it practical and concise.

## Current non-goals

The current examples do not add:

- local agent profile parsing.
- automatic activation of packaged examples.
- `devspace agents init`.
- generated available-agent catalogs.
- first-class agent runtime tools.
- ACP-backed execution.

Those can be added in later PRs without changing the template intent.
