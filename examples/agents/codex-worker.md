---
schema: devspace-agent/v1
name: codex-worker
description: Codex implementation worker for focused, user-approved coding tasks.
provider: codex
backend: cli

capabilities:
  read: true
  write: true
  shell: true
  background: true
  resume: true

workspace:
  default: current
  isolation: user_decides
  writeMode: allowed

actions:
  start:
    command: codex
    args:
      - exec
      - --json
      - -C
      - "{workspace}"
      - "{prompt}"
    background: true
    output: jsonl

  followup:
    strategy: resume_command
    command: codex
    args:
      - exec
      - resume
      - "{externalSessionId}"
      - --json
      - "{prompt}"

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

Use this agent when ChatGPT has already planned a focused implementation and the
user wants Codex to execute it locally.

Good tasks:

- Implement a small feature from a clear plan.
- Fix a bug with known reproduction steps.
- Add tests for an existing code path.
- Apply review comments.

Worker prompt style:

```text
You are a local implementation worker under ChatGPT supervision.

Goal:
<goal>

Plan:
<numbered implementation plan>

Constraints:
<constraints>

Files to focus:
<files>

Tests to run:
<tests>

Rules:
- Keep changes focused.
- Follow existing project style.
- Do not perform unrelated refactors.
- Do not hide failures.
- Return a final report.

Final report format:
summary:
files_changed:
tests_run:
blockers:
follow_up_needed:
```
