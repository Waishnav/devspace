# Codex Worker Pipeline Design

## Summary

DevSpace will retain its existing MCP workspace workflow and add an optional local Worker pipeline. ChatGPT is the external planning actor: it uses DevSpace's existing MCP file tools to write a Task Spec contract to `<project>/.devspace/spec/current.json`. DevSpace validates and deterministically compiles that Spec into versioned execution tasks, then invokes the installed `codex` CLI inside a DevSpace-managed Git worktree.

DevSpace does not add a Planner or Planner prompt. The first version also excludes verification, verifier MCP tools, task DAGs, parallel execution, automatic retries, commits, and pushes.

## Goals

- Let ChatGPT hand structured implementation work to a local Codex Worker.
- Execute the Task Spec in an isolated Git worktree.
- Preserve task status, logs, and resulting changes for inspection.
- Keep all existing `serve`, `init`, `doctor`, `config`, and MCP behavior unchanged.
- Keep the handoff inspectable through a project-local JSON file.
- Make the exact Worker input reproducible through a versioned compiler and persisted compiled prompts.

## Non-Goals

- Generating plans or Task Specs inside the DevSpace CLI.
- Adding a Planner model call or Planner prompt.
- Running the target project's tests, lint commands, or builds automatically.
- Exposing Worker or Verifier as MCP tools.
- Automatically retrying or repairing failed tasks.
- Scheduling a task dependency graph or running tasks concurrently.
- Claiming that a resumed mutable worktree is a deterministic replay.
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

DevSpace reads `.devspace/spec/current.json` from the current directory, validates and lints it, compiles it into versioned execution tasks, creates a run record and managed worktree, and executes each task sequentially with a fresh Worker Codex session. All tasks share the same worktree.

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

Unknown fields are rejected so malformed or unexpectedly expanded input fails before execution. The Worker treats the Spec as instructions, not as authority to operate outside the managed worktree.

## Spec Lint

Schema validation is followed by deterministic semantic linting:

- task IDs must be unique;
- the Spec must contain between 1 and 100 tasks;
- task IDs are limited to 64 characters, titles to 200, instructions to 20,000, and each constraint or acceptance criterion to 2,000;
- each task may declare at most 100 files, 100 constraints, and 100 acceptance criteria;
- IDs, titles, instructions, constraints, and acceptance criteria must be non-empty after trimming;
- declared file paths must be project-relative and cannot contain `..`, absolute roots, or null bytes;
- declared paths that do not exist in the base checkout produce warnings rather than errors because a task may create them.

The linter does not judge whether a natural-language constraint is sensible. It also does not validate task dependencies because dependencies are not part of the version 1 contract.

## Components

### CLI Router

Extends the existing command parser with `run`, `status`, and `runs`. Existing command behavior remains unchanged. CLI parsing is separated from execution enough to test argument handling without spawning processes.

### Spec Schema and Loader

Owns the Zod schema and inferred TypeScript types. It resolves `.devspace/spec/current.json` relative to the current project, parses it, and validates it before a run or worktree is created.

### Task Compiler

Transforms a validated Spec snapshot into normalized `ExecutionTask` records. Compilation is deterministic for the tuple `(spec version, compiler version, worker prompt version, Spec snapshot, task ID)`.

Each compiled task contains the normalized task fields, run and task identity, base commit SHA, prompt version, exact prompt text, and a SHA-256 prompt hash. The compiled prompt is persisted before a Worker starts, so later debugging does not depend on reconstructing historical template behavior.

The initial template is shipped as `worker-prompt-v1.md`. A change that can alter Worker interpretation requires a new prompt version rather than silently mutating version 1.

### Worker Backend

The orchestrator depends on a narrow `WorkerBackend` interface that accepts a compiled execution task, working directory, output sink, and cancellation signal, then returns a structured exit result. The interface owns execution only; it does not create worktrees or mutate run state.

The MVP provides one implementation, `CodexCliWorker`. Queue, parallel, remote, or alternate-model backends remain out of scope but do not require changing the orchestrator contract.

### Codex CLI Worker

Locates and invokes the local `codex` executable without shell interpolation. It starts a fresh Codex process for each task attempt in the run worktree and sends the exact compiled prompt. The adapter receives an injectable executable path and process runner so tests never invoke a real model.

### Run Store

Persists run metadata under `~/.devspace/runs/<run-id>` using atomic file replacement. A run directory contains:

```text
run.json
spec.json
execution-plan.json
events.jsonl
tasks/
  T1/
    attempt-1.prompt.md
    attempt-1.log
run.lock
```

`spec.json` is an immutable snapshot of the project-local Spec. `execution-plan.json` stores normalized tasks, compiler and prompt versions, and prompt hashes. `events.jsonl` is the canonical append-only state history. `run.json` is an atomically replaced current-state projection for fast status reads. Large process output remains in per-attempt log files.

### Worktree Coordinator

Reuses the repository's existing managed-worktree primitives where practical. The source project must be a Git repository with at least one commit. The Spec is loaded from the source checkout before the worktree is created, so the Spec itself does not need to be committed to Git.

Uncommitted source changes are not copied into the managed worktree. If the source checkout is dirty, DevSpace reports that fact and continues from `HEAD`, matching the existing managed-worktree behavior.

### Worker Orchestrator

Coordinates validation, compilation, run creation, state transitions, worktree setup, and task execution. It depends on `WorkerBackend` rather than Codex process details and remains independent of CLI presentation.

## Data Flow

### Handoff

1. ChatGPT inspects the project through existing DevSpace MCP tools.
2. ChatGPT writes `.devspace/spec/current.json` with existing MCP edit/write tools.
3. The user can inspect or edit the JSON before execution.

### Execution

1. Resolve the current directory as the source project.
2. Load and validate `.devspace/spec/current.json`.
3. Run deterministic semantic lint and report warnings and errors.
4. Confirm that `codex` is available and resolve the source repository's base commit SHA.
5. Compile and persist the immutable Spec snapshot and versioned execution plan.
6. Create the run event journal and current-state projection.
7. Acquire the run's exclusive lock and create the managed worktree at the recorded base SHA.
8. Append the transition from `planned` to `running` and update the projection.
9. For each non-completed task in specification order:
   - mark the task `running`;
   - allocate a monotonically increasing attempt number;
   - persist the compiled prompt and its hash for that attempt;
   - invoke a fresh Worker session through `WorkerBackend` in the shared worktree;
   - stream process output to the attempt log;
   - mark the task `completed` on exit code zero;
   - otherwise mark the task and run `failed`, then stop.
10. Mark the run `completed` after every task completes.
11. Release the lock in a `finally` path.

Re-running a failed run is done explicitly with `devspace run <run-id>`. It skips completed tasks and creates a new attempt for the first incomplete task in the same mutable worktree. This is recovery, not deterministic replay. Running `devspace run` without an ID creates a new run, records the current `HEAD` as its base SHA, snapshots the current Spec, and creates a fresh worktree.

## Worker Prompt and Boundaries

The Task Compiler builds the Worker prompt from the overall goal, architecture summary, exactly one assigned task, normalized constraints, and acceptance criteria. It prohibits redesign, unrelated features, commits, and pushes. Each Worker process can inspect and modify the shared worktree but receives no authority outside it.

Prompt bytes and hashes are persisted per attempt. Compiler and prompt versions are stored in the execution plan, independently of the Spec schema version.

## State Model

Runs use these states:

- `planned`: valid Spec snapshot persisted; execution has not started.
- `running`: the lock is held and a task may be active.
- `completed`: every task completed successfully.
- `failed`: worktree creation or a Worker process failed.

Tasks use `pending`, `running`, `completed`, and `failed`. A stale `running` state discovered without an active lock is reported as interrupted and is eligible for explicit resume.

## Event Journal and Projection

Every state change is first appended as a versioned event to `events.jsonl`, including run creation, worktree creation, task attempt start, Worker exit, task completion or failure, and run completion or failure. Events carry a monotonically increasing sequence number, timestamp, run ID, event type, and event-specific payload.

While the run lock is held, DevSpace is the sole writer. After appending an event it atomically replaces `run.json` with the newly reduced projection. Recovery can rebuild `run.json` by replaying valid events in sequence. If a process dies during the last append, a syntactically incomplete final JSONL line is ignored and reported; malformed or out-of-order earlier events are treated as corruption.

Logs and worktree contents are execution artifacts, not state authority. An attempt event records the prompt hash, log path, process result, and relevant timestamps.

## Error Handling

- Missing Spec: fail with the expected absolute path and do not create a run.
- Invalid Spec JSON or schema: report precise validation issues and do not create a run.
- Spec lint errors: report all deterministic errors and warnings; do not create a run when errors exist.
- Missing `codex`: fail with installation/path guidance and do not create a run.
- Invalid project or repository without a commit: fail before run creation.
- Duplicate execution: reject when the run lock is held.
- Worktree failure: mark the created run failed without starting a Worker.
- Worker non-zero exit or interruption: mark the current task and run failed, preserve all changes and logs, and stop subsequent tasks.
- Persistence failure: preserve the previous projection; rebuild it from the valid journal prefix on the next status or resume operation.
- Journal corruption before the final line or a sequence gap: refuse execution and report the corrupt event location.

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
- semantic lint limits, safe paths, and missing-path warnings;
- default Spec path resolution and malformed input;
- deterministic compilation, prompt versions, and stable prompt hashes;
- run state transitions, event reduction, and atomic projection persistence;
- truncated final-event recovery and earlier-event corruption rejection;
- latest-run selection and command argument parsing;
- attempt numbering, recovery semantics, and lock rejection;
- orchestrator behavior through a fake `WorkerBackend`.

Integration tests use a fake `codex` executable and temporary Git repositories to verify:

- a project-local Spec creates a valid persisted run snapshot;
- execution creates a worktree and runs tasks in order;
- an uncommitted Spec can still drive the Worker;
- tasks share changes through the same worktree;
- a failed Worker stops later tasks and preserves state and logs;
- explicit resume skips completed tasks and creates a new attempt;
- a new run uses a fresh worktree and records its own base SHA.

The pipeline does not run tests, lint, or build commands from the generated target project.

## Delivery Boundary

The MVP is complete when the three CLI commands work with a local Codex installation, compiled Worker inputs are versioned and inspectable, run state can be reconstructed from its event journal, existing MCP behavior remains unchanged, orchestration tests pass without a real model, and the DevSpace package build succeeds.
