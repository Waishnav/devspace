---
name: devspace-workflow
description: Run concise DevSpace planning, goal, and answer workflows with minimal narration.
license: MIT
metadata:
  version: 1.0.0
  author: DevSpace
  category: workflow
  updated: 2026-06-20
---

# DevSpace Workflow

## What This Skill Does

Use this skill when the user drives DevSpace with concise workflow messages such as `/plan`, `/goal`, or compact answers to pending questions.

## Before Starting

1. Confirm you already have a `workspaceId` for the active project.
2. If there is no open workspace, call `open_workspace` first.
3. Reuse the same `workspaceId`; do not reopen the same folder unless it stops working or the user explicitly asks.
4. Keep replies short and operational unless the user asks for explanation.

## Workflow Modes

### Plan Workflow

Trigger on messages like:

- `@dev /plan ...`
- `/plan ...`

Use `handle_workspace_command` first, then continue the planning workflow in `plan` mode.

### Goal Workflow

Trigger on messages like:

- `@dev /goal ...`
- `/goal ...`

Use `handle_workspace_command` first, then continue with `create_goal`, `get_goal`, and `update_goal` as needed.

### Compact Answers

Trigger when there is pending `request_user_input` state and the user replies with compact text such as `1B，2A`, `1B, 2A`, or `1b 2a`.

Prefer passing the raw reply through `handle_workspace_command` or `answer_user_input(text)` instead of paraphrasing it.

### Batch File Changes

When the user asks for broad or multi-file modifications, prefer `apply_workspace_patch` with a unified diff patch instead of shell redirection, heredocs, generated scripts, or ad-hoc write commands.

### Git Push

When the user explicitly asks to push commits, prefer `git_push` with structured `remote`, `branch`, and `setUpstream` arguments instead of `bash` with a raw `git push` command.

## Response Standard

- Bottom line first.
- Prefer action over explanation.
- For simple workflow steps, return a short status.
- Do not explain slash semantics or MCP mechanics unless the user asks.

## References

- [Command Mapping](references/commands.md)
- [Response Style](references/style.md)
- [Examples](references/examples.md)

## Related Skills

- `senior-architect-lite` for architecture decisions before or during `/plan`
- `skill-authoring-lite` for creating or refactoring DevSpace skills with the same structure
