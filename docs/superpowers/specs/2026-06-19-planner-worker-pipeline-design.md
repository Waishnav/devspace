# Planner–Worker Pipeline Design

## Summary

DevSpace will retain its existing MCP workspace workflow and add an optional local CLI pipeline. The pipeline uses the locally installed `codex` CLI in two strictly separated roles: a read-only Planner that produces a validated task specification, and a Worker that executes those tasks inside a DevSpace-managed Git worktree.

The first version intentionally excludes verification, verifier MCP tools, task DAGs, parallel execution, automatic retries, commits, and pushes.

## Goals

- Turn a natural-language goal into a structured, replayable task specification.
- Execute the specification with Codex in an isolated Git worktree.
- Preserve prompts, task status, logs, and resulting changes for inspection.
- Keep all existing `serve`, `init`, `doctor`, `config`, and MCP behavior unchanged.

## Non-Goals

- Running the target project's tests, lint commands, or builds automatically.
- Exposing Planner, Worker, or Verifier as MCP tools.
- Automatically retrying or repairing failed tasks.
- Scheduling a task dependency graph or running tasks concurrently.
- Committing or pushing generated changes.
- Supporting model providers other than the local `codex` CLI in this version.

## User Experience

### Plan

```bash
devspace plan "add a login flow" --project /path/to/project
```

DevSpace validates the project, invokes Codex with the Planner prompt and read-only permissions, validates its JSON output, and creates a run under `~/.devspace/runs/<run-id>`. Failed Planner output is retained separately under `~/.devspace/planner-failures` for diagnosis and does not become a runnable run.

### Run

```bash
devspace run [run-id]
```

DevSpace executes the named run. If the ID is omitted, it selects the most recent run in `planned` state. It creates a managed worktree and executes each task sequentially with a fresh Worker Codex session. All tasks share the same worktree.

### Inspect

```bash
devspace status [run-id]
devspace runs
```

`status` shows the specification summary, run state, per-task state, worktree path, log paths, and Git diff statistics. With no ID it selects the most recent run. `runs` lists recent runs in reverse chronological order.

## Task Specification

The persisted specification is strict, versioned JSON validated with Zod.

```json
{
  "version": 1,
  "project": "devspace",
  "goal": "Add an optional Planner–Worker pipeline",
  "architecturePlan": {
    "summary": "Add CLI orchestration without changing MCP behavior",
    "modules": [
      {
        "name": "pipeline",
        "responsibility": "Persist and execute pipeline runs",
        "files": ["src/pipeline/run-store.ts"]
      }
    ]
  },
  "tasks": [
    {
      "id": "T1",
      "title": "Add run persistence",
      "instruction": "Implement the versioned run store described in this specification.",
      "files": ["src/pipeline/run-store.ts"],
      "constraints": ["Do not change existing MCP behavior"],
      "acceptanceCriteria": ["Runs can be created, loaded, and listed"]
    }
  ]
}
```

Task IDs must be unique, and `tasks` must contain at least one task. Unknown fields are rejected so malformed or unexpectedly expanded Planner output fails before execution.

## Components

### CLI Router

Extends the existing command parser with `plan`, `run`, `status`, and `runs`. Existing command behavior remains unchanged. CLI parsing is separated from execution enough to test argument handling without spawning processes.

### Spec Schema

Owns the Zod schema and inferred TypeScript types. It validates Planner output at the boundary before anything is persisted or executed.

### Codex Adapter

Locates and invokes the local `codex` executable. It provides two operations:

- `plan`: invokes Codex in read-only mode with the Planner prompt and captures its final output.
- `executeTask`: invokes a fresh Codex process in the run worktree with the Worker prompt and one task.

The adapter receives an injectable executable path and process runner so tests never invoke a real model.

### Run Store

Persists run metadata under `~/.devspace/runs/<run-id>` using atomic file replacement. A run directory contains:

```text
run.json
spec.json
planner.log
tasks/
  T1.log
run.lock
```

`run.json` stores timestamps, project path, worktree path, overall state, and per-task state. Large process output remains in log files.

### Worktree Coordinator

Reuses the repository's existing managed-worktree primitives where practical. The worktree is created only after a valid specification exists and `run` begins. The source repository must be a Git repository with at least one commit.

### Pipeline Orchestrator

Coordinates state transitions and task execution. It is independent of CLI presentation and Codex process details.

## Data Flow

### Planning

1. Resolve and validate the project path.
2. Confirm that `codex` is available and the project is a Git repository with a commit.
3. Invoke the read-only Planner with the goal and compact repository context.
4. Extract exactly one JSON object from the final Planner response.
5. Validate it against the strict schema.
6. Persist the specification and a run in `planned` state.

No worktree is created when planning fails.

### Execution

1. Resolve the requested run and acquire its exclusive lock.
2. Create the managed worktree if the run does not already have one.
3. Transition the run from `planned` to `running`.
4. For each non-completed task in specification order:
   - mark the task `running`;
   - invoke a fresh Worker Codex session in the shared worktree;
   - stream process output to the task log;
   - mark the task `completed` on exit code zero;
   - otherwise mark the task and run `failed`, then stop.
5. Mark the run `completed` after every task completes.
6. Release the lock in a `finally` path.

Re-running a failed run skips completed tasks and resumes at the first incomplete task. There is no automatic retry; a new invocation is an explicit user action.

## Prompts and Role Separation

The Planner prompt requires architecture design, small executable tasks, no code changes, and a single JSON response matching the schema. The Codex process runs with read-only permissions.

The Worker prompt includes the overall goal, architecture summary, and exactly one assigned task. It prohibits redesign, unrelated features, commits, and pushes. Each Worker process can inspect and modify the shared worktree but receives no authority outside it.

Prompt templates ship with the package and are versioned alongside the schema.

## State Model

Runs use these states:

- `planned`: valid specification persisted; execution has not started.
- `running`: the lock is held and a task may be active.
- `completed`: every task completed successfully.
- `failed`: planning was already successful, but worktree creation or a Worker process failed.

Tasks use `pending`, `running`, `completed`, and `failed`. A stale `running` state discovered without an active lock is reported as interrupted and is eligible for explicit resume.

## Error Handling

- Missing `codex`: fail with installation/path guidance.
- Invalid project or repository without a commit: fail before invoking Planner.
- Invalid Planner JSON: retain the Planner log under `~/.devspace/planner-failures`, report schema issues, and do not create a run under `runs`.
- Duplicate execution: reject when the run lock is held.
- Worktree failure: mark the run failed without starting a Worker.
- Worker non-zero exit or interruption: mark the current task and run failed, preserve all changes and logs, and stop subsequent tasks.
- Persistence failure: use atomic writes so the previous valid state file remains readable.

No failure causes automatic worktree deletion.

## Security and Isolation

- Planning is read-only.
- Worker execution is confined by working directory and prompt to the managed worktree.
- Existing allowed-root and MCP authorization behavior is not broadened.
- Goals and model output are treated as untrusted input when constructing process arguments; no shell interpolation is used.
- Logs are local under the existing DevSpace user directory and may contain source excerpts, so they are not transmitted or pushed automatically.

## Testing

Unit tests cover:

- strict Task Spec validation and duplicate task IDs;
- Planner JSON extraction and malformed output;
- run state transitions and atomic persistence;
- latest-run selection and command argument parsing;
- resume behavior and lock rejection.

Integration tests use a fake `codex` executable and temporary Git repositories to verify:

- Planner output creates a valid persisted run;
- execution creates a worktree and runs tasks in order;
- tasks share changes through the same worktree;
- a failed Worker stops later tasks and preserves state and logs;
- resuming skips completed tasks.

The pipeline does not run tests, lint, or build commands from the generated target project.

## Delivery Boundary

The MVP is complete when the four CLI commands work with a local Codex installation, existing MCP behavior remains unchanged, orchestration tests pass with a fake Codex executable, and the package build succeeds.
