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
    command: opencode
    args:
      - run
      - --format
      - json
      - --dir
      - "{workspace}"
      - "{prompt}"
    background: true
    output: jsonl

  followup:
    strategy: resume_command
    command: opencode
    args:
      - run
      - --format
      - json
      - --session
      - "{externalSessionId}"
      - --dir
      - "{workspace}"
      - "{prompt}"

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

Worker prompt style:

```text
You are a read-only OpenCode explorer.

Question:
<question>

Scope:
<scope>

Rules:
- Do not modify files.
- Cite exact file paths.
- Prefer concise findings.
- State uncertainty.

Final report format:
answer:
evidence:
relevant_files:
confidence:
unknowns:
```
