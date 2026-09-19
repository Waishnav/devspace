---
name: workflows
description: Write and run JavaScript workflows that coordinate multiple DevSpace subagents, including parallel tasks, pipelines, structured results, and reusable saved scripts.
---

# DevSpace dynamic workflows

Use a workflow when JavaScript branching, iteration, or coordinating several bounded agents helps complete the task. Discover configured targets with `devspace agents targets`; use their names as `agentType`. The host owns orchestration and can inspect or control each run.

Scripts begin with literal metadata. The remaining body supports top-level await and return:

```javascript
export const meta = {
  name: "parallel-review",
  description: "Review independent areas and synthesize findings",
  phases: [{ title: "Review" }, { title: "Synthesize" }]
};
phase("Review");
const reviews = await parallel(args.areas.map(area => () =>
  agent(`Review ${area}. Return concrete findings with file references.`, {
    agentType: "reviewer", label: area
  })
));
phase("Synthesize");
return await agent(`Combine these findings: ${JSON.stringify(reviews)}`);
```

Supply self-contained prompts: workers do not inherit the host conversation. Agent targets, model names, and supported effort settings come from DevSpace configuration. Do not invent provider-specific identifiers.

## Script primitives

- `await agent(prompt, options?)` starts a fresh logical agent and returns final text. With `options.schema`, it returns validated JSON. Options: `label`, `phase`, `schema` (JSON Schema), `model`, `effort`, `isolation: "worktree"`, `agentType`. A skipped, stopped, policy-blocked, or terminally failed agent resolves to `null`; its distinct outcome remains visible in step details.
- `await parallel([() => task(), ...])` runs tasks concurrently, preserves order, and returns `null` for a failed branch. Inspect failures before synthesis.
- `await pipeline(items, stage1, stage2, ...)` runs each item through the stages; different items overlap. A failed item becomes `null` and skips later stages. A stage that successfully returns `null` still passes that value to the next stage.
- `phase(title)` labels subsequent work. `log(message)` records progress.
- `args` is the JSON value supplied at launch. It is `undefined` when omitted; explicit `null` remains null.
- `budget.total` is the output-token limit or `null`. `budget.spent()` and `budget.remaining()` use reported usage. Unlimited remaining is `Infinity`. An unavailable usage report raises an error rather than reporting zero. In-flight calls may overshoot a token limit.
- `await workflow("saved-name", childArgs?)` or `await workflow({scriptPath: ".devspace/workflows/review.js"}, childArgs?)` invokes one nested workflow level in a separate script context. The child receives only explicitly supplied arguments; omitted child arguments become `undefined`, while explicit `null` remains null.

The script environment has JavaScript built-ins and these primitives, without Node, filesystem, network, timers, or module imports. Agents perform project work through their configured tools. Shell commands used by agents still run with local-user authority. Workflow workers must return further delegation needs to their owning script; their inherited CLI context blocks extra DevSpace agent launches. ACP cannot guarantee that its provider will disable internal delegation. Use worktree isolation for independent changes that should not share a checkout; changes remain available for inspection and are not automatically merged.

## Launch and observe

Use `run_workflow` with the existing `workspace_id` and a `script`, workspace-relative `script_path`, or saved `name`. When more than one is supplied, `script_path` takes precedence over `name`, then `script`; diagnostics report the selected source. Optional launch settings are `args`, `agent_type`, `model`, `effort`, `output_token_budget`. The receipt contains the run ID. Use `get_workflow` or `wait_workflow` with `run_id`; pass `after_revision` to wait for fresh progress. Disconnection or wait timeout does not cancel work. If `eventsTruncated` is true, use `get_workflow` with `after_revision: nextEventRevision` to retrieve the next event page; use `revision` when waiting for new state.

CLI equivalents:

```bash
devspace workflows run .devspace/workflows/review.js --args-file input.json
devspace workflows show <run-id>
devspace workflows wait <run-id> --timeout 30
devspace workflows ls --definitions
```

`control_workflow` accepts `pause`, `resume`, `stop`, `stop_agent`, `restart_agent`; individual controls require `step_id`. Pause holds new launches and result delivery while running agents finish. Restart only applies before a result reaches the script. Stopping requests cancellation; it does not undo edits or provider charges.

To replay a prior run, launch its source with `resume_from_run_id`. Matching delivered results are reused. Script branches and arguments must match the recorded history; replay can reject divergence. Undelivered side effects may have occurred, so inspect their workspace before retrying.

`save_workflow` saves a run's source under a kebab-case `name` in `location: "project"` or `"user"`. Use `replace: true` only when replacing that saved definition is intended. Project definitions live in `.devspace/workflows`; personal definitions live in the DevSpace configuration directory's `workflows` folder.
