# Resume & journal

Dynamic workflows are editable programs. Resume lets you change the plan mid-flight (or after a kill) without redoing finished `agent()` work.

## Handles returned at launch

| Field | Use |
|---|---|
| `runId` | Pass as `resumeFromRunId` on the next `Workflow` call |
| `scriptPath` | Edit in place; re-invoke without resending full `script` |
| `transcriptDir` | Subagent transcripts + `journal.jsonl` |
| `taskId` | Stop / track the background task |

## How to resume

1. **Stop** the prior run if it is still running (background task stop / equivalent).  
2. Relaunch:

```js
Workflow({
  scriptPath: '/…/workflows/scripts/review-wf_abc.js',
  resumeFromRunId: 'wf_abc…',
  args: previousArgs, // keep identical for full cache when script unchanged
})
```

Same-session only for `resumeFromRunId` (local runs).

## Cache identity rule

The engine finds the **longest unchanged prefix** of `agent()` calls:

- Same **prompt** + same **opts** (as hashed for identity) → return **cached** result instantly.  
- First **edited or new** `agent()` call and **everything after it** run live.

| Scenario | Result |
|---|---|
| Same script + same `args` | ~100% cache hit |
| Edit only post-processing after the last `agent()` | Cache hit all agents; re-run pure JS tail |
| Change prompt of agent #3 of 10 | Agents 1–2 cached; 3–10 live |
| Insert a new `agent()` early | From that call onward live |

## Why scripts ban entropy

`Date.now()`, `Math.random()`, and bare `new Date()` throw in scripts so control flow and prompt construction cannot silently diverge between original run and resume. See [script contract](./script-contract.md).

If you need wall-clock:

- Pass a fixed ISO string via `args` at launch, or  
- Stamp times in the coordinator after the workflow returns.

## `journal.jsonl`

Path: `<transcriptDir>/journal.jsonl`

- Records each agent’s **actual return value**.  
- Before diagnosing empty or surprising workflow results, **read the journal** — do not assume cached results are non-empty.  
- Fallback if no journal: read `agent-<id>.jsonl` files in the transcript directory and hand-author a continuation script.

## Operational patterns

### Fix a bad verify stage after a long review

1. Leave review `agent()` prompts unchanged.  
2. Edit only verify-stage prompts / schema in `scriptPath`.  
3. Resume with same `args` → review results cache; verify re-runs.

### Add a completeness-critic pass

1. Append a new phase + `agent()` at the end of the script.  
2. Resume → entire prior prefix caches; only the new agent runs.

### Re-run pure aggregation

1. Change only the `return` / merge logic (no `agent()` signature changes).  
2. Resume → full agent cache; new aggregation.

## Failure modes to watch

| Symptom | Check |
|---|---|
| Empty confirmed list | Journal: did judges return `null`? schema fail? |
| Unexpected re-run of early agents | Prompt/opts drift (template changed, args differ) |
| Resume rejected / no cache | Wrong session, missing `runId`, prior run not stopped |
| Divergent args | Even with same script, different `args` can change prompts that embed `args` → cache miss from first embedded call |

## Relation to durability

Claude Code resume is **session-oriented prefix replay** of orchestration journals. It is not the same as a multi-day durable job supervisor with external leases (a different control plane). For long-lived external orchestration, see product-specific durable systems; this doc describes the model-facing Workflow resume API only.

## Next

- [Patterns](./patterns.md)
- [Lifecycle](./lifecycle.md)
