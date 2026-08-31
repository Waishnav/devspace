# DevSpace

DevSpace is a local development execution layer for MCP hosts such as ChatGPT and Claude. It gives a remote host workspace-scoped tools for reading, editing, searching, running commands, managing Git worktrees, reviewing changes, and coordinating bounded subagents on the user's machine.

Pi's SDK currently provides mature local coding primitives. DevSpace wraps those primitives in a Streamable HTTP MCP server and adds the product-specific boundaries around them: approved roots, workspace state, instructions, process sessions, worktrees, artifacts, review checkpoints, widgets, and subagent execution.

DevSpace owns tooling mechanics. The model receives only meaningful and actionable choices. The user sees outcomes. Tool defination should not leak internal implementation or it shoudn't be giving unwanted options to model to choose from if tooling can handle this.

## Product model

These ideas should stay true as the project evolves:

1. **The host is the orchestrator.** DevSpace exposes clear capabilities and execution state. It should not hide the workflow inside an opaque, uninspectable agent loop.
2. **Everything happens in a workspace.** A workspace represents one local project directory or worktree plus the instructions and state accumulated while operating in it.
3. **Local authority stays explicit.** DevSpace runs with access to the user's machine. Roots, paths, commands, processes, credentials, and destructive operations must be treated as product boundaries.
4. **Subagents are bounded workers.** A subagent should have an explicit task, profile, working context, lifecycle, and result that the host can inspect and coordinate.
5. **Adapters stay at the edges.** Pi, MCP hosts, and model providers each have their own terminology and capabilities. Provider-specific behavior should not become the core domain model.
6. **Prefer composable primitives.** Build a small set of reliable operations that can be combined into larger workflows instead of baking every workflow into the server.

## Glossary

- **Host** — the MCP client presenting the agent experience and coordinating work.
- **Server** — the local DevSpace MCP server.
- **Workspace** — one opened directory or worktree and its accumulated instruction context.
- **`workspaceId`** — the opaque handle returned by `open_workspace` and reused for calls in that workspace.
- **Allowed root** — a configured filesystem boundary within which a workspace may be opened. It is not itself necessarily a workspace.
- **Checkout mode** — operating on an existing checkout supplied by the user.
- **Worktree mode** — operating in an isolated Git worktree.
- **Tool surface** — the tools exposed by a configured mode, such as minimal, full, or Codex-compatible.
- **Process session** — a long-running command tracked for later input, output, or termination.
- **Instruction file** — an `AGENTS.md` or `CLAUDE.md` discovered while navigating a workspace.
- **Subagent** — a bounded model invocation delegated and coordinated by the host.
- **Agent profile** — the model, provider, tools, and instructions used for a subagent.
- **Artifact** — an output surfaced for the host or user to inspect.
- **Review checkpoint** — stored state representing a coherent set of changes.
- **Widget** — host-rendered UI/Cards attached to an MCP response.

Use these terms precisely. In particular, do not use workspace, allowed root, checkout, and worktree interchangeably.

## Security boundaries

Filesystem tools enforce approved-root containment. Shell commands run with the local user's authority and are not a general sandbox. Never imply that shell execution is contained merely because file tools are contained.

Resolve and validate paths before destructive actions. Do not broaden an allowed root, delete application state, expose a credential, or replace an existing process as a convenient fix.

Keep tunnel ownership and credentials with the user. DevSpace may operate through a user-controlled tunnel, but it does not own tunnel lifecycle or configuration.

## Diagnose the correct layer

A failure may belong to the host, MCP transport, DevSpace, a Pi adapter, a provider, a model, a tool implementation, or the target project. Preserve the original error and identify the failing boundary before changing code.

An adapter exception is not evidence that a model failed. A successful command is not evidence that a GUI opened, a host refreshed, or a user-visible workflow succeeded.

Do not expand DevSpace's responsibility while fixing a local symptom. Host UI, provider model naming, tunnel management, and duplicated review experiences require an explicit product decision.

## Verify the real path

Determine how the user will consume the change and verify that path. Behavior may differ between:

- the source checkout and the packaged `npm`/`npx` installation;
- a direct terminal client and a real MCP host;
- a fresh process and a server or host that needs restarting;
- checkout mode and worktree mode;
- Linux, macOS, and Windows Bash environments;
- minimal, full, and Codex-compatible tool surfaces;
- widgets enabled, disabled, or limited to change review.

State clearly when only a narrower proxy was verified. For model-facing schemas, inspect what the host receives. For UI and artifacts, inspect the rendered result rather than inferring success from the producing command.

## Trace affected contracts

When changing a cross-cutting concept, check every surface it actually reaches:

- MCP schema, handler, description, and response;
- workspace lifecycle and instruction loading;
- allowed-root and path-containment behavior;
- checkout and worktree modes;
- process and subagent lifecycle;
- tool-surface filtering;
- widgets, artifacts, and review checkpoints;
- persistence and migrations;
- packaged entry points, documentation, and examples.

This is a map, not a requirement to touch every surface on every change. Avoid both incomplete contracts and speculative edits.

## Pull requests

Only create or update a PR when explicitly asked, and read `CONTRIBUTING.md` first. Keep a PR focused on one coherent concern and use a conventional title such as `fix:`, `feat:`, `docs:`, `refactor:`, or `chore:`.

Write the body as a few natural paragraphs explaining the problem and solution. Include verification, risk, or migration context only when it helps the reviewer. Avoid generated boilerplate, commit inventories, file-by-file narration, generic checklists, and mandatory `Testing` sections.

For UI changes, include before/after images and a short interaction video when behavior changes. Inspect the final diff before filing. When available, use the `file-pr` workflow to file the PR and `babysit-pr` to monitor CI and reviews.

## Where code lives

- `src/server.ts` — MCP server setup, tool registration, and response wiring.
- `src/workspaces.ts` — workspace lifecycle, instructions, skills, and profiles.
- `src/roots.ts` — allowed roots and path containment.
- `src/process-sessions.ts` — long-running process lifecycle.
- `src/git.ts` and `src/git-worktrees.ts` — Git and worktree operations.
- `src/local-agent-*.ts` — subagent configuration, providers, and execution.
- `src/artifact-*.ts` and `src/incoming-artifacts.ts` — artifact handling.
- `src/review-checkpoints.ts` — persisted change-review checkpoints.
- `src/ui/` — MCP widgets.
- `src/db/` — persisted local state and migrations.
- `test/` — behavior and regression tests.

Start at the boundary named by the problem and follow the data. Keep policy in DevSpace, provider translation in adapters, and important behavior in schemas, types, checks, or explicit tool results rather than hidden prompt conventions.

## Project taste

- Prefer explicit lifecycle and state over hidden autonomy.
- Make tasks, inputs, outputs, failures, and ownership inspectable.
- Keep subagent execution composable and independently testable.
- Preserve host and provider data unless DevSpace has a concrete reason to normalize it.
- Add compatibility behavior only for an identified consumer with a real upgrade path.
- Reuse glossary terms in schemas, types, documentation, and errors.
- Keep the execution layer small, reliable, and unsurprising.