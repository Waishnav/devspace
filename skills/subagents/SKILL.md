---
name: subagents
description: Delegate focused coding, research, review, or verification work to a bounded DevSpace subagent. Use when a task benefits from separate context, a specialist perspective, or a follow-up with the same worker.
---

# DevSpace subagents

Run the DevSpace CLI through the shell or process tool from the project the subagent should use. Agent commands print compact XML fragments by default. Read that output directly. Do not add `--json`.

## Choose a target

Discover usable targets instead of guessing names:

```bash
devspace agents targets
```

Each line is a `<provider/>` or `<profile>description</profile>` fragment. Prefer a matching profile. Use a provider target when no profile fits or the task needs a specific provider. Keep the configured model and effort unless the task requires a supported override.

## Start work

Give the subagent a self-contained brief with the objective, relevant paths, constraints, context it cannot infer, and the expected result. The subagent receives this brief and its profile instructions, not the parent conversation.

```bash
devspace agents run <profile-or-provider> "<brief>"
devspace agents run <profile-or-provider> --model <model> --effort <effort> "<brief>"
```

The command returns an `<agent id="agt_..." status="running"/>` receipt. Keep the DevSpace agent ID for inspection, waiting, or follow-up.

## Wait or inspect

Use `wait` when work must finish before you proceed. One call can wait for several agents:

```bash
devspace agents wait <id>
devspace agents wait <id> <id> <id>
devspace agents wait <id> <id> --timeout 60
```

Without `--timeout`, the command waits until every named agent's current work finishes. A timeout returns one fragment per unique agent in first-seen order; unfinished work has `status="running" wait="timeout"`. Completed output is the element text. Failures include `code` and `retryable` attributes. The command does not stream partial results.

Use `show` for an immediate snapshot. Do not poll it when `wait` can express the dependency.

```bash
devspace agents show <id>
devspace agents ls
```

`ls` lists agents for the current project. Empty `targets` and `ls` results print nothing.

## Continue related work

Continue an agent when its existing provider context helps. Start another agent for unrelated work.

```bash
devspace agents continue <id> "<follow-up brief>"
devspace agents wait <id>
```

## Good uses

- Review a change for correctness, security, or missing tests.
- Investigate a bounded part of a codebase and report findings.
- Implement one isolated change with clear acceptance criteria.
- Run a focused verification pass after other work.
