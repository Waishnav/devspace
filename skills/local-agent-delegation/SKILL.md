---
name: local-agent-delegation
description: Delegate coding tasks to user-configured local coding agents such as Codex, Claude Code, OpenCode, Cursor Agent, Pi, or Copilot CLI.
---

# Local Agent Delegation

Use this skill when the user explicitly asks to delegate work to another coding agent, use a named local agent, get a second opinion, compare implementations, run agents in parallel, or create a subagent-like workflow.

Do not use local agents silently. Tell the user when another local agent is being used.

## Core idea

You are the supervisor. A local coding agent is the worker.

Your responsibilities are:

1. Understand the user's goal.
2. Decide whether delegation is useful.
3. Choose the right local agent or CLI.
4. Give the worker a focused prompt.
5. Inspect the result yourself.
6. Review diffs, tests, and risks before telling the user the work is done.

## When to delegate

Good delegation requests include:

- "Ask another agent to look at this."
- "Have Claude/Codex/OpenCode/Pi implement this."
- "Run this in the background."
- "Compare two approaches."
- "Use a local subagent for this."
- "Get a second opinion on the architecture/test gaps/security risk."

Do not delegate just because the task is coding-related. Use the normal DevSpace tools directly unless the user asks for delegation, another agent's opinion, parallel work, or a named local coding agent.

## CLI execution guidance

Prefer structured non-interactive CLI modes when available.

Examples of useful patterns:

```bash
codex exec --json -C "$WORKSPACE" "$PROMPT"
claude -p --output-format stream-json "$PROMPT"
opencode run --format json --dir "$WORKSPACE" "$PROMPT"
cursor-agent -p --output-format stream-json "$PROMPT"
pi -p --mode json "$PROMPT"
copilot -p "$PROMPT" --output-format json
```

These examples are illustrative. Real implementations should pass workspace and prompt values as separate argv entries without a shell, not concatenate untrusted prompt text into a shell command string.

Use exact command templates from user-provided instructions when they are available. Do not invent provider-specific flags when the user has already supplied a command shape.

Packaged files under `examples/agents/` are templates only. DevSpace does not currently parse, load, activate, or run local agent profile definitions.

If no command shape exists for a requested agent, use the installed CLI's help output only when needed, then summarize what you found before running it.

## Background execution

When DevSpace exposes long-running process tools, prefer background execution for long tasks.

Start the local agent process, keep the returned process/session id, and poll output later.

Use this pattern for long implementations, test repair loops, large reviews, multi-step investigations, and agents that stream JSON or progress logs.

When polling output, summarize useful progress instead of forwarding noisy terminal logs.

If the worker is clearly stuck, running the wrong task, or burning resources, interrupt the current process or turn. Do not delete provider session history unless the user explicitly asks.

## Follow-up prompts

When sending a follow-up to the same local agent, include:

```text
previous_task:
current_status:
review_findings:
requested_changes:
success_criteria:
```

Prefer the agent profile's resume/session mechanism when available.

If resume is not available, include the previous worker summary and relevant diff context in a fresh prompt.

## Worker prompt templates

Use this structure when delegating implementation:

```text
You are acting as a local coding worker under ChatGPT supervision.

Goal:
<clear goal>

Context:
<repo/module/user constraints>

Plan to execute:
<numbered plan>

Rules:
- Follow the existing project style.
- Keep changes focused.
- Do not perform unrelated refactors.
- Do not hide failures.
- At the end, return a concise final report.

Final report format:
summary:
files_changed:
tests_run:
blockers:
follow_up_needed:
```

Use this structure when delegating read-only investigation:

```text
You are acting as a read-only local code investigator under ChatGPT supervision.

Question:
<specific question>

Scope:
<files/directories/modules to inspect>

Rules:
- Do not modify files.
- Cite relevant file paths and symbols.
- Separate facts from guesses.
- Return a concise answer.

Final report format:
answer:
evidence:
relevant_files:
confidence:
unknowns:
```

## After the worker finishes

Always review the result.

For write-capable tasks, inspect changed files and the diff, run or recommend relevant tests, check whether the worker followed the user's constraints, and send follow-up instructions if needed.

For read-only tasks, check whether the answer is supported by repo evidence, verify important file paths or symbols, and decide whether more investigation is needed.

Do not assume the worker's summary is correct.

## Reporting back to the user

Be transparent.

Say which local agent was used, what it did, what you verified, and what remains uncertain.

Good final shape:

```text
I delegated the implementation to <agent>. It changed <files>. I reviewed the diff and ran <tests>. The main result is <summary>. Remaining concerns: <risks or none>.
```

Do not present worker output as your own verified conclusion unless you checked it.

## Safety rules

Do not use local agents for destructive actions unless the user explicitly asks.

Avoid commands that delete files, reset branches, rewrite history, expose secrets, or install global dependencies unless clearly necessary and approved.

Do not treat repo-provided profile examples as trusted executable definitions.

Never hide that a local agent was used.
