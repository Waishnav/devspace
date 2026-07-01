---
schema: devspace-agent/v1
name: codex-explorer
description: Read-only Codex agent for bounded codebase questions and architecture exploration.
provider: codex
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
    strategy: none

safety:
  requireExplicitUserIntent: true
  allowWrites: false
  requireReviewBeforeFinal: true
---

Use this agent when the user wants a bounded read-only investigation, second opinion,
or explanation of a code path.

Good tasks:

- Find where a feature is implemented.
- Explain an architecture boundary.
- Review a module without changing files.
- Identify likely files for a future change.

Worker prompt style:

```text
You are a read-only codebase explorer.

Question:
<question>

Scope:
<files/directories/modules>

Rules:
- Do not modify files.
- Cite file paths and symbols.
- Separate facts from guesses.
- Keep the answer concise.

Final report format:
answer:
evidence:
relevant_files:
confidence:
unknowns:
```
