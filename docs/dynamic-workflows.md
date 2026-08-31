# Subagents And Dynamic Workflows

DevSpace exposes one agent execution layer through its CLI. Coding harnesses
such as Codex, Pi, OpenCode, or Cursor can call it directly. ChatGPT and Claude
can call the same commands through DevSpace's ordinary shell or process tools.
There are no dedicated subagent or workflow-execution MCP tools.

## Setup

Run `devspace init` and enable agent tooling. Setup probes the supported
providers, asks which ones DevSpace may use, and prints installation commands
for two Coding Agent skills:

- `subagents` for one bounded delegation and later follow-ups
- `dynamic-workflows` for programmed multi-agent orchestration

Provider selection is stored as provider objects under `subagents` in
`~/.devspace/config.jsonc`. Runtime availability is checked again before a
provider is shown or used. MCP workspaces load the bundled copies when
subagents are enabled.

## Project Scope

Run agent commands from the intended project. When an MCP host invokes the CLI,
DevSpace injects the opened workspace identity. In a standalone harness,
DevSpace discovers the current Git repository or project directory. Lists,
lookups, continuations, status checks, and cancellations stay inside that
scope.

## Direct Subagents

```bash
devspace agents targets --json
devspace agents run <profile-or-provider> "<brief>" --json
devspace agents show <id> --json
devspace agents continue <id> "<follow-up>" --json
devspace agents stop <id> --json
devspace agents ls --json
```

Use a direct subagent for one focused implementation, investigation, review, or
verification task. Profiles can supply role instructions and provider/model
defaults. The child runs independently and returns an id that the orchestrator
polls or continues.

## Dynamic Workflows

```bash
devspace workflow run --name <name> --json
devspace workflow run --file <script.js> --arg key=value --json
devspace workflow status <run-id> --json
devspace workflow calls <run-id> --json
devspace workflow call <run-id> <call-index> --json
devspace workflow cancel <run-id> --json
devspace workflow ls --json
devspace workflow tui [run-id]
```

Named scripts live in `.devspace/workflows/<name>.js`. A script can combine
`agent`, `parallel`, `pipeline`, `phase`, `log`, and one-level nested
`workflow` calls. Agent calls can request structured JSON or an isolated Git
worktree.

Agent harnesses should prefer `--json`, retain the returned id, and poll status.
This avoids coupling a long workflow lifetime to one tool-call timeout.
`--follow` remains available for interactive terminals with long-running
process support.

`workflow tui` opens a project-scoped, read-only Navigator. Without a run id it
starts on the workflow list; with a run id it opens that run directly. Opening a
run shows its declared phases beside the agent calls in the selected phase.
Calls without a declared phase are grouped under `Other`. Terminals narrower
than 80 columns show one pane at a time, with `Tab` switching panes. Opening a
call exposes normalized activity, prompt, result, worktree details, and provider
metadata. Use arrow keys (or `j`/`k`) to navigate, `Tab` to switch panes or
inspector sections, `Enter` to open, `Esc` to go back, and `q` to quit.

Elapsed time is derived from persisted call timestamps. Token counts are
best-effort provider observations: a running call may show a partial snapshot,
while a completed call shows its final provider-reported total. Providers that
cannot report a value remain visibly unavailable instead of being estimated.
Replayed calls do not contribute tokens to the current run.

Failed and cancelled workflows are terminal. `workflow run --resume <run-id>`
creates a new run, reuses the unchanged successful prefix when safe, and
continues live from the first failed or changed call.

## MCP Boundary

`open_workspace` exposes the current compact subagent profile and provider
catalog from the core agent system. It does not include active workflow runs,
workflow phases, session identifiers, or internal counters. Hosts inspect
those only when needed through `devspace workflow` commands. This keeps the
host as the orchestrator without adding a second workflow-specific MCP or
dashboard surface.
