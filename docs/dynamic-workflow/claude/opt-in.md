# Opt-in & Ultracode

Workflows can spawn dozens of agents and consume large token budgets. Claude Code therefore gates the `Workflow` tool behind **explicit user opt-in**. A task that would merely “benefit from parallelism” is not enough.

## When Workflow is allowed

The model may call `Workflow` only when at least one of these holds:

1. **Keyword `ultracode` in the user prompt**  
   A system-reminder confirms it for that turn/session context.

2. **Session ultracode is on**  
   Standing opt-in for every substantive task (see below).

3. **User asks in their own words** for multi-agent orchestration  
   Examples: “use a workflow”, “run a workflow”, “fan out agents”, “orchestrate this with subagents”.  
   The ask must be in the **user’s** words — not inferred from task complexity.

4. **A skill / slash command’s instructions** tell the model to call Workflow.

5. **User asks for a specific named / saved workflow.**

## When Workflow is not allowed

Even if multi-agent would clearly help:

- Silent model decision that “parallel is better.”
- Inferring opt-in from difficulty alone.
- “This would be faster with more agents” without user request.

**Fallback:**

- Use the single `Agent` tool for one-off subagents, or
- Briefly describe what a multi-agent workflow would do and rough cost, and ask. Mention the user can say “use a workflow” later to skip the ask.

## Ultracode mode

When a system-reminder confirms ultracode is **on**:

| Rule | Behavior |
|---|---|
| Opt-in | Standing — every substantive task may/should use a workflow |
| Goal | Most exhaustive correct answer; token cost is not a constraint |
| Multi-phase | Often **several workflows in sequence** (understand → design → implement → review) so the coordinator stays in the loop between phases |
| Patterns | Prefer adversarial verify, multi-modal sweep, completeness critic, loop-until-dry where they fit |
| Solo exception | Pure conversation or trivial mechanical edits only |

When ultracode is **off**, revert to the explicit opt-in list above.

## Hybrid still applies

Opt-in does not mean “dump the whole task into one script immediately.”

1. Scout inline → discover work-list.  
2. Author workflow over that list.  
3. Synthesize; chain next phase if needed.

## Cost and size guidelines

Users may set a **workflow size guideline** in `/config` (e.g. small ≈ 5 agents, medium ≈ 15, large ≈ 50, unrestricted). This is a **guideline** for the model’s authoring behavior, not the same as the engine’s hard caps ([limits](./limits.md)).

Budget directives (“+500k”-style) feed `budget.total` inside scripts — a **hard** ceiling on further `agent()` calls once spent. See [control-and-io](./control-and-io.md).

## Next

- [Workflow tool API](./workflow-tool.md)
- [Orchestration altitude](./orchestration.md)
