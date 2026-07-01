---
schema: devspace-agent/v1
name: copilot-reviewer
description: GitHub Copilot CLI reviewer for read-only code questions and review passes.
provider: copilot
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
    command: copilot
    args:
      - --model
      - auto
      - -p
      - "{prompt}"
      - --output-format
      - json
    background: true
    output: jsonl

  followup:
    strategy: resume_command
    command: copilot
    args:
      - --model
      - auto
      - -p
      - "{prompt}"
      - --resume
      - "{externalSessionId}"
      - --output-format
      - json

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

Use this agent when the user wants a GitHub Copilot-powered second opinion,
review, or codebase answer.

Good tasks:

- Review changed files.
- Find likely bug sources.
- Explain repository structure.
- Suggest tests.

Worker prompt style:

```text
You are a read-only Copilot reviewer under ChatGPT supervision.

Question:
<question>

Scope:
<scope>

Rules:
- Do not modify files.
- Cite exact files and symbols.
- Return concise findings.
- Separate facts from guesses.

Final report format:
answer:
findings:
evidence:
relevant_files:
confidence:
unknowns:
```
