# Lifecycle & operator UX

How a workflow run feels end-to-end.

## Happy path

```
1. Authoring
   Coordinator scouts → builds work-list → writes inline script (or picks name)

2. Permission
   User sees meta.description (+ size guideline if configured)

3. Launch
   Workflow tool returns immediately:
     taskId, runId, scriptPath, transcriptDir, workflowName, status

4. Progress
   /workflows shows:
     · phase groups
     · agent labels
     · nested child workflow groups
     · narrator log() lines

5. Completion
   <task-notification> delivers script return value to coordinator

6. Synthesis
   Coordinator may:
     · answer the user
     · edit scriptPath + resume
     · launch another Workflow for the next phase
```

## Multi-phase product work

Prefer **several workflows across turns** over one mega-script:

| Turn | Workflow | Coordinator does after |
|---|---|---|
| 1 | Understand | Read map; decide design scope |
| 2 | Design panel | Pick approach with user if needed |
| 3 | Implement + review repair | Inspect diff; request fixes |
| 4 | Verify / audit | Ship narrative + residual risk |

The coordinator **stays in the loop** between phases — that is a feature. Ultracode makes this the default for substantive work ([opt-in](./opt-in.md)).

## Hybrid single-phase

```
scout (inline tools)
  → Workflow(pipeline over discovered items)
    → synthesize answer
```

You need the work-list shape before the orchestration step, not before any investigation.

## Background vs blocking mental model

From the model’s perspective:

- The `Workflow` **tool call** returns once the run is **registered** (async launch).  
- The **result of the script** arrives later via notification / task completion channel.  
- Do not assume the tool return value is the script’s `return {…}` object.

Operators watch `/workflows` for live structure.

## Iteration loop

```
launch → observe → Edit(scriptPath) → stop if needed → resumeFromRunId
```

See [resume](./resume.md).

## Failure / skip paths

| Event | Typical handling |
|---|---|
| Syntax error in script | `error` on launch result; fix script, relaunch |
| User denies permission | No run; ask or fall back to single Agent |
| User skips individual agent | That `agent()` → `null`; filter and continue or abort in script |
| Budget exhausted | Further `agent()` throws; catch / end loop; return partial |
| Agent terminal API failure | `null`; log; optionally retry with new call (not automatic) |

## Named vs inline scripts

| Mode | When |
|---|---|
| Inline `script` | First design of a one-off harness |
| `scriptPath` iterate | Evolving a run without re-pasting |
| `name` / `.claude/workflows/` | Reusable team harnesses |
| Nested `workflow(name)` | Compose reusable pieces inside a parent script |

## Common single-phase catalog

| Name | Intent |
|---|---|
| Understand | Parallel readers → structured map |
| Design | Judge panel → scored synthesis |
| Review | Dimensions → find → adversarially verify |
| Research | Multi-modal sweep → deep-read → synthesize |
| Migrate | Discover → transform (worktree) → verify |

## Next

- [One level above / orchestration](./orchestration.md)
- [Use cases](./usecases.md)
