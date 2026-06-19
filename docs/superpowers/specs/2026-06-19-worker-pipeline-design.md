# Codex Worker Pipeline Design

## Summary

DevSpace will retain its existing MCP workspace workflow and add an optional local Worker pipeline. ChatGPT acts as the external Planner: it uses DevSpace's existing MCP file tools to write a validated Task Spec contract to `<project>/.devspace/spec/current.json`. The local DevSpace CLI reads that Spec and invokes the installed `codex` CLI to execute its tasks inside a DevSpace-managed Git worktree.

DevSpace does not add a Planner or Planner prompt. The first version also excludes verification, verifier MCP tools, task DAGs, parallel execution, automatic retries, commits, and pushes.

## Goals

- Let ChatGPT hand structured implementation work to a local Codex Worker.
- Execute the Task Spec in an isolated Git worktree.
- Preserve task status, logs, and resulting changes for inspection.
- Keep all existing `serve`, `init`, `doctor`, `config`, and MCP behavior unchanged.
- Keep the handoff inspectable through a project-local JSON file.

## Non-Goals

- Generating plans or Task Specs inside the DevSpace CLI.
- Adding a Planner model call or Planner prompt.
- Running the target project's tests, lint commands, or builds automatically.
- Exposing Worker or Verifier as MCP tools.
- Automatically retrying or repairing failed tasks.
- Scheduling a task dependency graph or running tasks concurrently.
- Committing or pushing generated changes.
- Supporting model providers other than the local `codex` CLI in this version.

## User Experience

### ChatGPT Handoff

ChatGPT uses the existing DevSpace MCP workflow to inspect the project, design the work, and write:

```text
<project>/.devspace/spec/current.json
```

The Spec is ordinary project data. The user decides whether to ignore it or commit it.

### Run

From the source project checkout:

```bash
devspace run
```

DevSpace reads `.devspace/spec/current.json` from the current directory, validates it, creates a run record, creates a managed worktree, and executes each task sequentially with a fresh Worker Codex session. All tasks share the same worktree.

### Inspect

```bash
devspace status [run-id]
devspace runs
```

`status` shows the specification summary, run state, per-task state, source project, worktree path, log paths, and Git diff statistics. With no ID it selects the most recent run. `runs` lists recent runs in reverse chronological order.

## Task Specification

The project-local specification is strict, versioned JSON validated with Zod.

```json
{
  "version": 1,
  "project": "devspace",
  "goal": "Add an optional Codex Worker pipeline",
  "architecturePlan": {
    "summary": "Add CLI execution without changing MCP behavior",
    "modules": [
      {
        "name": "worker-pipeline",
        "responsibility": "Persist and execute Worker runs",
        "files": ["src/worker/run-store.ts"]
      }
    ]
  },
  "tasks": [
    {
      "id": "T1",
      "title": "Add run persistence",
      "instruction": "Implement the versioned run store described in this specification.",
      "files": ["src/worker/run-store.ts"],
      "constraints": ["Do not change existing MCP behavior"],
      "acceptanceCriteria": ["Runs can be created, loaded, and listed"]
    }
  ]
}
```

Task IDs must be unique, and `tasks` must contain at least one task. Unknown fields are rejected so malformed or unexpectedly expanded input fails before execution. The Worker treats the Spec as instructions, not as authority to operate outside the managed worktree.

## Components

### CLI Router

Extends the existing command parser with `run`, `status`, and `runs`. Existing command behavior remains unchanged. CLI parsing is separated from execution enough to test argument handling without spawning processes.

### Spec Schema and Loader

Owns the Zod schema and inferred TypeScript types. It resolves `.devspace/spec/current.json` relative to the current project, parses it, and validates it before a run or worktree is created.

### Codex Worker Adapter

Locates and invokes the local `codex` executable. It starts a fresh Codex process for each task in the run worktree. The adapter receives an injectable executable path and process runner so tests never invoke a real model.

### Run Store

Persists run metadata under `~/.devspace/runs/<run-id>` using atomic file replacement. A run directory contains:

```text
run.json
spec.json
tasks/
  T1.log
run.lock
```

`spec.json` is an immutable snapshot of the project-local Spec at run creation. `run.json` stores timestamps, source project path, worktree path, overall state, and per-task state. Large process output remains in task log files.

### Worktree Coordinator

Reuses the repository's existing managed-worktree primitives where practical. The source project must be a Git repository with at least one commit. The Spec is loaded from the source checkout before the worktree is created, so the Spec itself does not need to be committed to Git.

Uncommitted source changes are not copied into the managed worktree. If the source checkout is dirty, DevSpace reports that fact and continues from `HEAD`, matching the existing managed-worktree behavior.

### Worker Orchestrator

Coordinates validation, run creation, state transitions, worktree setup, and task execution. It is independent of CLI presentation and Codex process details.

## Data Flow

### Handoff

1. ChatGPT inspects the project through existing DevSpace MCP tools.
2. ChatGPT writes `.devspace/spec/current.json` with existing MCP edit/write tools.
3. The user can inspect or edit the JSON before execution.

### Execution

1. Resolve the current directory as the source project.
2. Load and validate `.devspace/spec/current.json`.
3. Confirm that `codex` is available and the source is a Git repository with a commit.
4. Create a run record containing an immutable Spec snapshot.
5. Acquire the run's exclusive lock and create the managed worktree.
6. Transition the run from `planned` to `running`.
7. For each non-completed task in specification order:
   - mark the task `running`;
   - invoke a fresh Worker Codex session in the shared worktree;
   - stream process output to the task log;
   - mark the task `completed` on exit code zero;
   - otherwise mark the task and run `failed`, then stop.
8. Mark the run `completed` after every task completes.
9. Release the lock in a `finally` path.

Re-running a failed run is done explicitly with `devspace run <run-id>`. It skips completed tasks and resumes at the first incomplete task. Running `devspace run` without an ID always creates a new run from the current project-local Spec rather than implicitly resuming an old run.

## Worker Prompt and Boundaries

The Worker prompt includes the overall goal, architecture summary, and exactly one assigned task. It prohibits redesign, unrelated features, commits, and pushes. Each Worker process can inspect and modify the shared worktree but receives no authority outside it.

The prompt template ships with the package and is versioned alongside the Spec schema.

## State Model

Runs use these states:

- `planned`: valid Spec snapshot persisted; execution has not started.
- `running`: the lock is held and a task may be active.
- `completed`: every task completed successfully.
- `failed`: worktree creation or a Worker process failed.

Tasks use `pending`, `running`, `completed`, and `failed`. A stale `running` state discovered without an active lock is reported as interrupted and is eligible for explicit resume.

## Error Handling

- Missing Spec: fail with the expected absolute path and do not create a run.
- Invalid Spec JSON or schema: report precise validation issues and do not create a run.
- Missing `codex`: fail with installation/path guidance and do not create a run.
- Invalid project or repository without a commit: fail before run creation.
- Duplicate execution: reject when the run lock is held.
- Worktree failure: mark the created run failed without starting a Worker.
- Worker non-zero exit or interruption: mark the current task and run failed, preserve all changes and logs, and stop subsequent tasks.
- Persistence failure: use atomic writes so the previous valid state file remains readable.

No failure causes automatic worktree deletion.

## Security and Isolation

- Existing allowed-root and MCP authorization behavior is not broadened.
- Worker execution is confined by working directory and prompt to the managed worktree.
- Spec text is treated as untrusted input when constructing process arguments; no shell interpolation is used.
- Logs are local under the existing DevSpace user directory and may contain source excerpts, so they are not transmitted or pushed automatically.
- The pipeline never commits or pushes generated changes.

## Testing

Unit tests cover:

- strict Task Spec validation and duplicate task IDs;
- default Spec path resolution and malformed input;
- run state transitions and atomic persistence;
- latest-run selection and command argument parsing;
- resume behavior and lock rejection.

Integration tests use a fake `codex` executable and temporary Git repositories to verify:

- a project-local Spec creates a valid persisted run snapshot;
- execution creates a worktree and runs tasks in order;
- an uncommitted Spec can still drive the Worker;
- tasks share changes through the same worktree;
- a failed Worker stops later tasks and preserves state and logs;
- explicit resume skips completed tasks.

The pipeline does not run tests, lint, or build commands from the generated target project.

## Delivery Boundary

The MVP is complete when the three CLI commands work with a local Codex installation, existing MCP behavior remains unchanged, orchestration tests pass with a fake Codex executable, and the DevSpace package build succeeds.
