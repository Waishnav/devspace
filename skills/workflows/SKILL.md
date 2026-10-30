---
name: workflows
description: Write, run, and inspect persisted multi-agent DevSpace workflows, JavaScript scripts that compose subagent calls with agent, phase, parallel, and pipeline.
---

# DevSpace workflows

Use a workflow when a task has a repeatable multi-agent plan. Keep one-off delegation on the `subagents` commands.

Named workflows live in the current project's `.devspace/workflows/` directory.

## Write a workflow

Before writing or editing a workflow script, read `reference.md` next to this file. It defines the only syntax and primitives the sandbox accepts (`agent`, `phase`, `parallel`, `pipeline`, `workflow`, `log`, `args`), the `meta` rules, `agent` options, structured output schemas, and limits. Do not guess the API.

Then read `patterns.md` for proven engineering loops to adapt: plan with a critic, implement-review-fix until approved, a QA gate that loops until tests pass, explore-then-synthesize, multi-lens review with verified findings, bake-offs between agents, mapping one change over many units, debugging with competing hypotheses, and composing them.

## Run a workflow

Run a named workflow or a specific file:

```bash
devspace workflow run --name <name> [--args '<json>']
devspace workflow run --file <path> [--args-file <path>]
```

The command returns a compact `<workflow id="..." status="..."/>` receipt. Keep the ID. Workflow code is read-only by default; add `--write-mode allowed` only when the workflow must modify the project.

Wait up to 60 seconds at a time. Repeat `wait` if the returned status is still running; do not poll `status` in a loop.

```bash
devspace workflow wait <id> --timeout 60
```

Inspect current state, calls, or one full call when needed:

```bash
devspace workflow status <id>
devspace workflow calls <id>
devspace workflow call <id> <index>
devspace workflow events <id> --after <last-sequence>
devspace workflow ls
```

`events` returns at most 100 persisted log and phase entries. Keep the highest sequence and pass it with `--after` for the next page.

Cancel only when the parent task no longer needs the run:

```bash
devspace workflow cancel <id>
```

Resume an interrupted or failed run from its durable call history. Resume reuses the original arguments and write mode:

```bash
devspace workflow run --resume <id>
```

Use `--json` only for scripts that need structured output.
