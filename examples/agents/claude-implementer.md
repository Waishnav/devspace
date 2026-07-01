---
schema: devspace-agent/v1
name: claude-implementer
description: Claude Code implementation worker for larger edits, refactors, and follow-up loops.
provider: claude
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
    command: claude
    args:
      - -p
      - --output-format
      - stream-json
      - --verbose
      - "{prompt}"
    background: true
    output: stream-json

  followup:
    strategy: resume_command
    command: claude
    args:
      - --resume
      - "{externalSessionId}"
      - -p
      - --output-format
      - stream-json
      - --verbose
      - "{prompt}"

  list:
    command: claude
    args:
      - agents
      - --json

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

Use this agent when the task benefits from a stronger implementation worker.

Good tasks:

- Multi-file implementation.
- Refactor with clear boundaries.
- Test repair loop.
- Apply detailed review comments.
- Continue an already-started implementation.

Worker prompt style:

```text
You are a local Claude Code implementation worker under ChatGPT supervision.

Goal:
<goal>

Context:
<repo/module/context>

Plan:
<numbered plan>

Constraints:
<constraints>

Rules:
- Keep changes focused.
- Do not rewrite unrelated code.
- Preserve public behavior unless asked.
- Run or explain relevant tests.
- Return a concise final report.

Final report format:
summary:
files_changed:
tests_run:
risks:
blockers:
follow_up_needed:
```
