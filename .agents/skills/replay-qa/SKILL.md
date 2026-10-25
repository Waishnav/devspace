---
name: replay-qa
description: Replay scripted MCP tool calls against an isolated DevSpace server and inspect the rendered cards in a real MCP Apps host with agent-browser. Use to verify a change, reproduce an issue, review a PR's UI or tool behavior, or QA any checkout without manual testing.
---

# Replay QA

`pnpm qa` replays scenario tool calls against a fresh DevSpace server, renders every card in a local MCP Apps host, and captures evidence with agent-browser.

Each run is isolated: its own `HOME`, config, SQLite state, worktree root, allowed root, and Git fixture under `.devspace-dev/qa/runs/<timestamp>/<scenario>/`. Ports are allocated dynamically, so runs never replace an existing process.

## Run

```bash
pnpm qa --list                       # scenarios and descriptions
pnpm qa                              # every scenario
pnpm qa codex-edit-review            # one scenario
pnpm qa --theme dark codex-edit-review
pnpm qa --bare-host codex-edit-review   # host sends a theme but no style variables
pnpm qa --checkout ../other-worktree    # QA another checkout with this harness
pnpm qa --no-build ...                  # skip `pnpm build:app` in the target checkout
```

The exit code is non-zero when a step fails its expectations, a card does not initialize or render, or the page reports errors.

Each run directory contains:

- `report.md`: pass/fail per step, card state and height, failures, and screenshot paths. Read this first.
- `transcript.json`: the tool list, every request and response, UI resources, and calls the cards made back to the server.
- `server.log`: the DevSpace server's JSON log.
- `artifacts/`: a full-page screenshot, one screenshot per card, an accessibility snapshot, the browser console, and `errors.json`.

Look at the screenshots before reporting UI behavior. A passing report means that cards rendered, not that they look right.

## Interact with cards

```bash
pnpm qa --serve --no-browser codex-edit-review   # prints the host URL and keeps running
export AGENT_BROWSER_SESSION=devspace-qa
agent-browser open "<host url>"
agent-browser wait --fn "window.__devspaceQa?.settled === true"
agent-browser snapshot -i       # card iframes appear inline with their buttons
agent-browser click @e12        # e.g. expand a file in the show_changes card
agent-browser screenshot "#step-3" /tmp/after.png
agent-browser close
```

Stop the serve process when finished. Card-initiated tool calls go through the host's same-origin `/api/call`, and are appended to `transcript.json` and shown under the card.

## Write a scenario

Add `scripts/qa/scenarios/<name>.json`:

```json
{
  "description": "What this proves.",
  "config": { "tools": { "mode": "claude" } },
  "host": { "clientName": "ChatGPT", "userAgent": "openai-mcp/1.0.0" },
  "fixture": {
    "files": { "README.md": "committed\n" },
    "dirty": { "README.md": "uncommitted\n" }
  },
  "steps": [
    { "tool": "open_workspace", "arguments": { "path": "{{fixture}}" } },
    {
      "tool": "exec_command",
      "arguments": { "workspace_id": "{{workspace_id}}", "cmd": "git status --short" },
      "expect": { "text": ["README.md"] }
    }
  ]
}
```

- `config` is deep-merged into the generated `config.jsonc`, and `env` adds server environment variables.
- `host` sets the OAuth `client_name` and the HTTP `User-Agent` the simulated host presents.
- `{{workspace_id}}` is the most recent workspace returned by a step.
- Make each fixture change through tool calls whenever possible, so the scenario exercises the real path.

## Comparing base and PR

Create a worktree for each revision, then run the same scenario with `--checkout` pointing at each one. Report `reproduces on base`, `fixed on PR`, or `not reproduced`. Do not infer this from the diff.

## Limits

The local host follows the MCP Apps protocol: a separate sandbox origin, CSP taken from resource metadata, host context, and server tools. It is still not ChatGPT or Claude. Use the real host when a claim depends on host-specific behavior such as `window.openai` globals, connector caching, OAuth reconnects, or display modes the local host does not implement.
