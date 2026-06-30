---
schema: devspace-agent/v1
name: opencode-explorer
description: OpenCode read-only explorer for fast codebase lookup and bounded questions.
provider: opencode
backend: cli

capabilities:
  read: true
  write: false
  shell: false
  background: true
  resume: true

workspace:
  default: current
  isolation: none
  writeMode: read_only

actions:
  start:
    command: "<opencode-cli>"
    args:
      - "<json-mode-flag>"
      - "<workspace-flag>"
      - "<workspace>"
      - "<prompt>"
    background: true
    output: json

  followup:
    strategy: fresh_prompt_with_context

  read:
    strategy: devspace_process_poll

  cancel:
    strategy: devspace_process_signal
    signal: SIGINT

  diff:
    strategy: none

safety:
  requireExplicitUserIntent: true
  allowWrites: false
  requireReviewBeforeFinal: true
---

Use this agent for fast, read-only codebase exploration.

Good tasks:

- Find relevant files.
- Explain a subsystem.
- Identify test coverage gaps.
- Compare possible implementation locations.

