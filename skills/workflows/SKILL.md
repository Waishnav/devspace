---
name: workflows
description: Run a persisted multi-agent DevSpace workflow from a script file or a named project workflow, then wait for or inspect its result.
---

# DevSpace workflows

Use a workflow when a task has a repeatable multi-agent plan. Keep one-off delegation on the `subagents` commands.

Named workflows live in the current project's `.devspace/workflows/` directory. Run a named workflow or a specific file:

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

Resume an interrupted or failed run from its durable call history:

```bash
devspace workflow run --resume <id> [--args '<json>']
```

Use `--json` only for scripts that need structured output.
