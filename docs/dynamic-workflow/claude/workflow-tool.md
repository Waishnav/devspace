# Workflow tool API

The model-facing tool name is **`Workflow`** (alias **`RunWorkflow`**).

- **Search hint:** orchestrate subagents with deterministic JavaScript workflow  
- **Execution:** background — tool returns immediately with a task id  
- **Completion:** `<task-notification>` when the script finishes  
- **Live progress:** `/workflows`

## When to use the tool (product intent)

A workflow structures work across many agents to be:

- **Comprehensive** — decompose and cover in parallel  
- **Confident** — independent perspectives and adversarial checks before committing  
- **Scalable** — migrations, audits, broad sweeps that one context cannot hold  

The script encodes structure: what fans out, what verifies, what synthesizes.

Control flow should be **deterministic** (loops, conditionals, fan-out in code) rather than re-decided free-form by the model mid-orchestration.

Common single-phase shapes (chain across turns for larger work):

| Phase | Pattern |
|---|---|
| Understand | parallel readers over subsystems → structured map |
| Design | judge panel of N approaches → scored synthesis |
| Review | dimensions → find → adversarially verify |
| Research | multi-modal sweep → deep-read → synthesize |
| Migrate | discover sites → transform (worktree) → verify |

See [opt-in](./opt-in.md) for permission to call this tool.

## Input fields

At least one of `script`, `name`, or `scriptPath` is required.

| Field | Type | Role |
|---|---|---|
| `script` | string (optional, length-bounded) | Inline self-contained workflow script. Must begin with pure-literal `export const meta = { name, description, phases }`. **Preferred on first invocation** — do not Write a file first. |
| `name` | string (optional) | Predefined workflow: built-in or from `.claude/workflows/`. Resolves to a full script. |
| `scriptPath` | string (optional) | Path to a script on disk. Every invocation **persists** its script under the session directory and returns the path. Iterate with Write/Edit + re-invoke. **Takes precedence** over `script` and `name`. |
| `args` | any (optional) | Exposed to the script as global `args`, **verbatim**. Pass real JSON arrays/objects — **not** a JSON-encoded string (stringified lists break `args.map` / `args.filter`). |
| `resumeFromRunId` | string `^wf_[a-z0-9-]{6,}$` (optional) | Prior run id. Unchanged prefix of `agent()` calls replays from cache; first edited/new call and everything after runs live. Same-session only. **Stop the prior run first** before resuming. |
| `description` | string (optional) | **Ignored** — set description in script `meta`. |
| `title` | string (optional) | **Ignored** — set title/name in script `meta`. |

### First run

```js
Workflow({
  script: `
export const meta = {
  name: 'review-changes',
  description: 'Review and adversarially verify findings',
  phases: [
    { title: 'Review' },
    { title: 'Verify' },
  ],
}
// ... body using agent/pipeline/parallel ...
return { confirmed }
`,
  args: { files: ['src/auth.ts', 'src/session.ts'] },
})
```

### Iterate without resending the full script

```js
// Edit the returned scriptPath via Write/Edit, then:
Workflow({
  scriptPath: returnedScriptPath,
  resumeFromRunId: runId, // optional: reuse cached agent() prefix
  args: { files: ['src/auth.ts', 'src/session.ts'] },
})
```

### Named workflow

```js
Workflow({
  name: 'review-changes',
  args: { topic: 'authentication' },
})
```

## Return envelope (conceptual)

The tool launches asynchronously. A typical success-shaped result includes:

```ts
{
  status: 'async_launched' | 'remote_launched',
  taskId: string,
  taskType?: 'local_workflow' | 'remote_agent',
  workflowName?: string,      // meta.name
  runId?: string,             // for resumeFromRunId (local)
  transcriptDir?: string,     // subagent transcripts + journal.jsonl
  scriptPath?: string,        // persisted script for this invocation
  summary?: string,
  sessionUrl?: string,        // when remote_launched
  warning?: string,           // non-blocking heads-up
  error?: string,             // e.g. syntax check failed
}
```

Notes:

- `runId` is the handle for [resume](./resume.md).
- `scriptPath` is the handle for iteration without resending `script`.
- `transcriptDir` holds per-agent logs and `journal.jsonl` (actual agent return values).
- Remote launches may use `sessionUrl` instead of local `runId` as the resume handle.

## Resolution order (engine behavior)

Conceptually the engine resolves input as:

1. If `scriptPath` → load (and optionally pair with inline `script` for built-in match checks).  
2. Else if `name` → resolve from built-ins / `.claude/workflows/`.  
3. Else if `script` → use inline body.  
4. Else → validation error: must provide script, name, or scriptPath.

## Relationship to the single Agent tool

| | `Agent` tool | `Workflow` tool |
|---|---|---|
| Count | One subagent (or a few manual launches) | Many, under a script graph |
| Control flow | Model re-decides each turn | Script encodes loops/fan-out |
| Structured multi-stage | Manual | `pipeline` / `parallel` + schema |
| Cost risk | Lower | Higher — gated by opt-in |
| Resume of a multi-step graph | Limited | Prefix-cached by agent call identity |

Use `Agent` for isolated one-offs. Use `Workflow` when the **structure** of multi-agent work must be reliable.

## Next

- [Script contract](./script-contract.md)
- [Primitives](./primitives.md)
