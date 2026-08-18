# Pure MCP Runtime Refactor

This branch changes DevSpace from an agent orchestrator into a local MCP execution runtime.

## Goal

Use the MCP host (for example ChatGPT) as the reasoning and coding agent. DevSpace only provides:

- workspace lifecycle
- files and search
- patches
- native shell execution
- persistent processes
- Git worktrees
- authentication
- review UI

## Removed concept

DevSpace no longer starts local model providers. Codex, Claude Agent SDK, OpenCode, Cursor/Copilot ACP, and similar adapters are not part of this runtime.

## Native mode

`DEVSPACE_TOOL_MODE=native` exposes a CLI-like environment. The host can use normal development commands and does not receive artificial instructions to avoid shell file operations.

The security boundary remains explicit:

- structured file tools are workspace-scoped;
- shell commands run with local user authority;
- worktrees provide change isolation, not OS sandboxing.

## Migration

Existing `DEVSPACE_TOOL_MODE=codex` configuration maps to `native` for compatibility.
