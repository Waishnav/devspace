# Limits & sandbox

Hard bounds and isolation properties of the Claude Code workflow engine (model-facing behavior).

## Engine caps

| Limit | Value | Behavior if exceeded |
|---|---|---|
| Concurrent `agent()` calls | `min(16, cpu_cores - 2)` **per workflow** | Excess **queue**; still complete |
| Lifetime agent count | **1000** per workflow run | Runaway-loop backstop |
| Items per `parallel` / `pipeline` call | **4096** | **Explicit error** (not silent truncate) |
| Script non-determinism | `Date.now` / `Math.random` / bare `new Date` | **Throw** |
| Nested `workflow()` depth | **1** | Nested call inside child **throws** |
| Token budget | User “+N” target if set | Further `agent()` **throws** when spent ≥ total |

Queued concurrency means you can pass large work-lists safely; wall-clock still stretches when the queue is deep.

## Soft guidelines (not hard engine caps)

| Guideline | Source |
|---|---|
| Workflow size: small ≈ 5, medium ≈ 15, large ≈ 50, unrestricted | User `/config` workflow size guideline |
| Thoroughness vs brevity | Task wording (“any bugs” vs “thoroughly audit”) |

The model should treat size guidelines as authoring policy unless the user explicitly overrides with scale language or ultracode.

## Script sandbox

| Available | Not available |
|---|---|
| Plain JS built-ins (`JSON`, `Math`, `Array`, …) | Node APIs, `require`, `process` |
| Injected primitives | Filesystem, network, subprocess from script |
| `agent` / nested `workflow` as escape hatches | Direct shell or edit from script |

Side effects (file edits, network via tools, git) happen **inside subagents** under normal Claude Code tool permission policy — not as raw script I/O.

## Worktree isolation (per agent)

```js
await agent(prompt, { isolation: 'worktree' })
```

| Property | Detail |
|---|---|
| Cost | ~200–500ms setup + disk **per agent** |
| Use when | Parallel **mutators** would conflict on one checkout |
| Cleanup | Auto-remove if worktree unchanged |
| Avoid when | Read-only work, single writer, or sequential mutators |

This is **opt-in per `agent()`**, not a default for all workers.

## Permission / product gates

Separate from engine caps:

- User must [opt in](./opt-in.md) (or enable ultracode) before `Workflow` is called.  
- Script `meta.description` surfaces in the permission dialog.  
- Individual agents may still hit tool permission prompts per session policy.

## MCP caveats

Workflow agents can use session-connected MCP tools via ToolSearch. **Interactively authenticated** MCP servers (e.g. browser login flows) may be absent in headless or cron-style runs.

## Practical sizing

| Ask | Rough shape |
|---|---|
| “Find any bugs” | Few finders, single-vote verify |
| “Thoroughly audit” | Larger finder pool, 3–5 vote adversarial pass, synthesis |
| Open-ended hunt + budget | `while (budget.total && budget.remaining() > …)` |
| Open-ended hunt, no budget | loop-until-dry with dry-round counter — not unbounded `while(true)` without exit |

## Next

- [Resume & journal](./resume.md)
- [Patterns](./patterns.md)
