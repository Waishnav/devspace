# Workflows

DevSpace workflows run persisted multi-agent plans through the same on-demand daemon as local subagents. A CLI process submits a run and exits immediately; the daemon remains alive until active workflows finish.

Place reusable workflow scripts in `.devspace/workflows/` and run them by name, or provide a file directly:

```js
export const meta = { name: "review", concurrency: 2 };

const findings = await agent("Review the current changes", {
  target: "reviewer",
  writeMode: "read_only",
});
return { findings };
```

The script body receives `args` plus the `agent`, `workflow`, `parallel`, `pipeline`, `phase`, and `log` helpers. It must return a JSON value. `agent(prompt, options)` requires a configured profile or provider in `options.target`; `workflow(name, args)` may call one named workflow, with nesting limited to one level.

`parallel(items, worker, concurrency)` returns one outcome per input instead of failing the whole batch when one worker throws. `pipeline(items, ...stages)` passes each raw item through every stage in order; each stage receives `(currentValue, originalItem, index)`. `phase(name, run)` records durable start, completion, and failure events and gives `run` an agent helper that labels its calls with that phase.

Run the script by name or provide a file directly:

```bash
devspace workflow run --name review --args '{"base":"main"}'
devspace workflow run --file ./review.workflow.js --args-file ./inputs.json
```

Exactly one of `--file`, `--name`, or `--resume` is required. `--file` reads the source before contacting the daemon. Named workflows are resolved inside the current workspace. Runs default to `read_only`; `--write-mode allowed` permits workflow calls configured for writes.

`run` returns an asynchronous receipt. Use the returned workflow ID with:

```bash
devspace workflow status <id>
devspace workflow wait <id> --timeout 60
devspace workflow calls <id>
devspace workflow call <id> <index>
devspace workflow events <id> --after <last-sequence> --json
devspace workflow cancel <id>
devspace workflow ls
```

`wait` accepts a timeout from 0 to 60 seconds and returns the latest durable run state on timeout. `calls` returns compact call summaries without prompts, results, or fingerprints. `call` returns the full stored record for one zero-based call index. `events` returns up to 100 persisted log and phase entries after the supplied sequence. All commands accept `--json` for scripts.

Workflow records, calls, and provider continuation state survive CLI exits and daemon restarts. A daemon restart marks unfinished workflows interrupted for explicit inspection or resume; it does not dispatch calls automatically. At startup the daemon first reconciles local agent turns, then workflow runs. During shutdown it closes workflows before the local agent manager so supervisors can stop their child turns cleanly.

Named workflows and their arguments are workspace scoped. IDs from another checkout, workspace, or managed worktree are rejected even when the caller can read the shared DevSpace state directory.

## Bounds

Workflow metadata may set `concurrency` from 1 to 16; the default is 4. The daemon admits at most eight active workflows and eight aggregate workflow agent turns, with at most sixteen script runners including nested scripts. One run may make at most 128 agent turns, including schema-correction turns, and may invoke at most eight nested workflows. Nesting is limited to one level and shares the parent run's admission, cancellation, and call budgets.

Scripts run in QuickJS with a 32 MiB heap, 512 KiB stack, and 15-minute wall clock limit. Source is limited to 64 KiB, arguments to 128 KiB, and workflow or agent results to 256 KiB. Guest `log()` and `phase()` events share a 64 KiB limit per run; bounded internal events such as agent turns and nested workflow source snapshots are additional. These are hard product boundaries rather than tuning controls.

An agent call may include an inline JSON Schema in `options.schema`. DevSpace compiles strict draft-07 structural schemas with at most 16 KiB, 512 nodes, and 16 levels. It rejects `$ref`, `$dynamicRef`, `$recursiveRef`, `$async`, `pattern`, `patternProperties`, and `format`. Invalid output gets one read-only correction in the same agent session; the correction counts toward the 128-turn budget.

## Resume and worktrees

Resume reuses only a matching prefix of completed read-only calls. Any call with write authority, isolation, or a named workflow workspace disables replay for the run. DevSpace also hashes the complete workspace root before the original and resumed runs. More than 20,000 entries, more than 64 MiB of files, any symlink, special file, unreadable path, or other hash failure produces `RECOVERY_CONTEXT_CHANGED`. Large generated trees such as `node_modules` can therefore conservatively disable resume.

An isolated call creates a managed worktree and records it as a workspace. DevSpace retains those worktrees after the run for inspection. Normal stale-worktree cleanup preserves recovery snapshots for commits and dirty tracked changes and skips worktrees with untracked files.

Profiles are resolved in each call’s execution workspace. For isolated worktrees, use global profiles or commit workspace profiles so they exist in the new worktree. A new worktree starts at the source’s committed `HEAD`; uncommitted source changes are not copied.
