---
name: browser-qa
description: Reproduce and verify DevSpace issues or PRs through the real MCP Apps UI with Agent Browser, capturing screenshots, video, console output, and exact repro steps. Use for issue triage, PR verification, UI changes, dogfooding, or end-to-end browser QA.
---

# DevSpace browser QA

Use browser QA to verify behavior at the host/UI seam. Do not replace a focused MCP, process, Git, or filesystem acceptance test with a browser test when the browser adds no signal.

## Deterministic MCP Apps smoke

Run:

```bash
pnpm qa:browser
```

This builds the current DevSpace app, starts an isolated DevSpace server and OAuth-authenticated proxy, runs the pinned official MCP Apps `basic-host`, and drives `open_workspace` followed by `show_changes` with Agent Browser. The run records screenshots, a WebM video/contact sheet, browser console/errors, a snapshot, and a Markdown report under:

```text
.devspace-dev/browser-qa/artifacts/<timestamp>/
```

The fixture and all downloaded host dependencies live under ignored `.devspace-dev/browser-qa/` state. The runner refuses to replace an existing process on one of its required ports.

## Exploratory issue or PR QA

Start the same authenticated reference host without running the built-in smoke:

```bash
pnpm qa:browser -- --serve
```

Keep that process running and use a worktree-scoped Agent Browser session for the investigation:

```bash
export AGENT_BROWSER_SESSION="$(agent-browser session id --scope worktree --prefix devspace-qa)"
agent-browser open http://127.0.0.1:8080
```

Before using Agent Browser, load its installed version-matched guidance:

```bash
agent-browser skills get core
agent-browser skills get dogfood
```

For a bug report, reproduce the claim once before collecting evidence. If it reproduces, start a clean video before the second reproduction and take screenshots at meaningful steps. For a fix, run the same acceptance scenario against the base revision and the PR revision when practical; report `reproduces on base`, `fixed on PR`, or `not reproduced` rather than inferring correctness from the diff.

Prefer the reference host for deterministic MCP App behavior. Use the existing `setup-qa` flow plus the real ChatGPT host only when the claim is specifically about ChatGPT behavior, reconnect/auth state, host capabilities, or rendering differences that the reference host cannot establish.

## Evidence standard

Interactive failures need a short reproduction video and step screenshots. Static visual issues need an annotated screenshot. Capture console/errors when relevant. Keep the report focused on observable behavior and distinguish confirmed failures from untested risks.
