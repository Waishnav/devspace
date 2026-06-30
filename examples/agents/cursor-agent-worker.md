---
schema: devspace-agent/v1
name: cursor-agent-worker
description: Cursor Agent worker for fast implementation or review using local Cursor CLI.
provider: cursor
backend: cli

capabilities:
  read: true
  write: true
  shell: true
  background: true
  resume: false

workspace:
  default: current
  isolation: user_decides
  writeMode: allowed

actions:
  start:
    command: "<cursor-agent-cli>"
    args:
      - "<print-mode-flag>"
      - "<json-output-flag>"
      - "<prompt>"
    background: true
    output: stream-json

  followup:
    strategy: fresh_prompt_with_context

  read:
    strategy: devspace_process_poll

  cancel:
    strategy: devspace_process_signal
    signal: SIGINT

  diff:
    strategy: git_diff

safety:
  requireExplicitUserIntent: true
  allowWrites: true
  requireDiffReview: true
  requireTestsOrExplanation: true
---

Use this agent when the user wants Cursor's local agent or model to quickly
execute or inspect a task.

Good tasks:

- Fast implementation pass.
- UI/UX-oriented code review.
- Alternative implementation idea.
- Lightweight refactor.

Because this profile uses `fresh_prompt_with_context`, include the previous
worker summary and review findings when sending follow-up work.

