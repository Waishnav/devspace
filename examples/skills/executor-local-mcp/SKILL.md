---
name: executor-local-mcp
description: Use the user's local Executor CLI to discover and call existing local MCP/API integrations from DevSpace shell tools.
---

# Executor Local MCP

Use this skill when the user asks to use Executor, local MCP tools, or local
integrations such as Obsidian, Zotero, Thunderbird, browser automation, or other
tools configured in Executor.

Executor is already available through the user's terminal. Do not ask DevSpace
for additional bridge tools. Use the existing DevSpace shell tool:

- In minimal or full tool mode, use `bash`.
- In codex tool mode, use `exec_command`.

## Discovery

First confirm Executor is installed and reachable when needed:

```bash
command -v executor
executor service status
```

List configured tool sources:

```bash
executor tools sources
```

Search for candidate tools before calling one:

```bash
executor tools search "zotero collections" --limit 20
```

Describe unfamiliar tools before invoking them:

```bash
executor tools describe zotero.user.default.zotero_list_collections
```

## Calling Tools

Call tools with `executor call`, splitting the dotted tool path into CLI path
segments and passing JSON arguments as the final argument:

```bash
executor call zotero user default zotero_list_collections '{}'
```

Use `user.default` by default for local single-user sources unless the user asks
for a different configured source.

## Safety

Prefer read-only discovery and query tools unless the user explicitly asks for a
mutation. Ask for confirmation before tools that send messages, delete data,
write notes, change app state, open UI actions on the user's machine, or expose
sensitive local content.

If Executor pauses for approval, show the approval URL or resume command to the
user and wait for confirmation before continuing.

Keep normal code work in DevSpace tools. Executor should be used for external
local integrations, not for reading or editing the current workspace.
