---
schema: devspace-agent/v1
name: pi-reviewer
description: Pi read-only reviewer for quick code review and targeted questions.
provider: pi
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
    command: pi
    args:
      - -p
      - --mode
      - json
      - "{prompt}"
    background: true
    output: jsonl

  followup:
    strategy: resume_command
    command: pi
    args:
      - -p
      - --mode
      - json
      - --session-id
      - "{externalSessionId}"
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

Use this agent for lightweight review and targeted read-only investigation.

Good tasks:

- Review a diff.
- Find possible bugs.
- Explain a small subsystem.
- Check whether tests cover an edge case.

Worker prompt style:

```text
You are a read-only local code reviewer.

Question:
<question>

Scope:
<scope>

Rules:
- Do not modify files.
- Cite evidence.
- Focus on actionable findings.
- Avoid broad rewrites.

Final report format:
findings:
evidence:
risk_level:
recommended_next_steps:
unknowns:
```
