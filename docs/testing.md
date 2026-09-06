# Testing DevSpace

Use two layers: focused tests for rules and difficult lifecycle failures, and
packaged MCP tests for workflows a host actually uses. E2E coverage is a reason
to remove duplicated happy paths, not to discard deterministic race, migration,
or partial-failure tests.

```bash
pnpm typecheck
pnpm test
pnpm test:e2e
```

`test:e2e` packs the checkout (including the normal build), installs it in a
temporary consumer directory, and launches the installed CLI. It needs Node,
pnpm, npm, Git, and registry access. The previous `test:package-install` command
is an alias for this suite; package launcher coverage now lives here.

The suite shares one package installation. Each scenario owns its temporary
project, Git history, config, SQLite state, OAuth grant, and server process.
It exercises the public HTTP boundary without importing `src/` or replacing
handlers. It uses the SDK client for legacy MCP and HTTP requests for the
2026-07-28 protocol, which has a different request envelope.

| Workflow | Observable failure it catches |
| --- | --- |
| Open, read, patch, execute, review, restart | Broken installed dependencies, tool wiring, instructions, workspace restoration, or persisted review content; runs over both protocols |
| Rejected edits | A failed multi-file patch partially changes a file, traversal escapes the workspace, or a patch follows an outside symlink |
| Worktree editing | An isolated edit modifies the source checkout or produces no usable review |
| Claude tool surface | The advertised write/edit tools cannot change files, or a write escapes through a parent path |
| Process sessions | Another workspace can send input to a process, or the owner cannot retrieve its result |
| Authentication and launchers | Invalid tokens are accepted, persisted grants cannot refresh after restart, or npm's CLI/daemon launchers break |

Run one scenario while developing:

```bash
pnpm exec tsx --test --test-name-pattern="process input" test/e2e/workflows.test.ts
```

Server output, package path, URL, PID, and exit details are retained in
`test-results/e2e/`. CI runs the suite on Linux, macOS, and Windows and uploads
these logs on failure. Teardown closes clients, stops only the owned child,
then removes its temporary state. A port collision fails startup; it never
reuses an unrelated server. There is no persistent development server.

These tests verify the local execution layer. They do not prove that ChatGPT
or Claude renders a widget correctly, that a live model chooses the right
tool, or that a provider account works. Review assertions inspect MCP payloads,
not rendered UI. Optional PTY dependencies are omitted from the consumer install,
so process coverage uses the pipe fallback. Keep focused PTY and provider tests.
Ordinary read/write symlink containment remains a known gap tracked in
[PR #264](https://github.com/Waishnav/devspace/pull/264); the symlink scenario
here covers the patch boundary only.

For agent-authored changes, name the consumer contract and a plausible bug
before adding a test. Extend one of these workflows when it covers the change.
Use a focused test when controlled ordering or a rare failure is the important
part. Assert the final files, state, or returned result, not merely that a mock
was called. See the testing guidance in [AGENTS.md](../AGENTS.md).
