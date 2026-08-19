---
name: subagents
description: Delegate focused coding, research, review, or verification work to a bounded DevSpace subagent. Use for one independent task, a specialist perspective, or a follow-up with the same worker; use Dynamic Workflows instead for programmed fan-out or multiple dependent stages.
---

# DevSpace subagents

Use the DevSpace CLI through the host's shell or process tool. Run commands from the project the subagent should work on. DevSpace scopes sessions to the host workspace when supplied, otherwise to the current Git repository or project directory.

## Choose a target

Discover usable targets instead of guessing names:

```bash
devspace agents targets --json
```

Prefer a configured profile whose description matches the task. Use a provider target when no profile fits or the user requests that provider. Unavailable providers are omitted.

Profiles carry their own provider, instructions, model, and effort defaults. Only pass `--model` or `--effort` when the user supplied an exact value or the value is already known to be valid for that target.

## Start work

Give the child a self-contained brief. Include the objective, relevant paths, constraints, decisions from the parent conversation, and the expected result. A child cannot see the parent conversation or ask the user for missing context.

```bash
devspace agents run <profile-or-provider> "<brief>" --json
devspace agents run <profile-or-provider> --model <model> --effort <effort> "<brief>" --json
```

The result contains an agent `id` and current status. Execution continues independently, so retain the id.

## Inspect and continue

```bash
devspace agents show <id> --json
devspace agents run <id> "<follow-up brief>" --json
devspace agents ls --json
```

- `show` returns the current status and includes the response or error when available.
- `run <id>` continues the same agent session with a new prompt.
- `ls` returns sessions belonging to the current project.

Poll `show --json` while the status is `starting` or `running`. `idle` means the response is ready; `error` and `stopped` are terminal without a successful response. Use a continuation only when the same context is valuable; start a new subagent for independent work.

## Good uses

- Review a change for correctness, security, or test gaps.
- Investigate a bounded part of a codebase and report findings.
- Implement one isolated feature with clear acceptance criteria.
- Run a focused verification pass after another agent's work.

Use a Dynamic Workflow when the task needs several agents, explicit phases, fan-out, pipelines, structured aggregation, or resumable orchestration.
