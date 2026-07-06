# DevSpace

This project exposes a local development workspace over MCP so ChatGPT, Claude,
or another MCP-capable host can operate directly on this machine's approved
development directories.

The goal is not to delegate work to a separate local coding agent. The MCP host
should call tools that read files, edit files, search code, and run shell
commands directly against approved local project roots.

Pi's SDK is currently used as the backend adapter for mature local coding
primitives such as read, edit, write, grep, find, ls, and bash. DevSpace wraps
those primitives behind a remote Streamable HTTP MCP interface, suitable for use
through a Cloudflare Tunnel.

The model-facing workflow is project based. MCP clients should call
`open_project` once per local project directory or worktree, then reuse the
returned `projectId` for subsequent tool calls in that same folder. Do not call
`open_project` again for the same folder unless the `projectId` is rejected as
unknown, the client switches folders/worktrees or checkout/worktree mode, or the
user explicitly asks to reopen. `AGENTS.md` files are returned automatically by
`open_project` and by later tool calls when the requested path enters a
directory with instructions that have not been loaded for that project.

Core constraints:

- Treat this as remote access to the local machine; security is part of the
  core design, not a later add-on.
- Start with a narrow filesystem allowlist.
- Prefer explicit, inspectable tool calls over autonomous local agent loops.
- Keep the first version small enough to validate with real ChatGPT/Claude MCP
  clients before adding UI or workflow features.
