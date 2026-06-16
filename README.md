<p align="center">
  <picture>
    <img src="docs/assets/devspace-logo-light.png" alt="DevSpace logo" width="140">
  </picture>
</p>

<h1 align="center">DevSpace</h1>

<p align="center">Bring a Codex-style coding workflow to ChatGPT.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@waishnav/devspace"><img alt="npm" src="https://img.shields.io/npm/v/%40waishnav%2Fdevspace?style=flat-square" /></a>
  <a href="https://github.com/Waishnav/devspace/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Waishnav/devspace/ci.yml?style=flat-square&branch=main" /></a>
  <a href="https://github.com/Waishnav/devspace/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/npm/l/%40waishnav%2Fdevspace?style=flat-square" /></a>
</p>

[![DevSpace connected to ChatGPT](docs/assets/devspace-screenshot.png)](docs/assets/devspace-screenshot.png)

**Give ChatGPT a secure connection to your own machine and Turn ChatGPT into Codex**

DevSpace is a self-hosted MCP server that lets ChatGPT read, edit, search, and run code in your real local projects — your files, your tools, your terminal — without uploading anything to a third party. You run it on your machine, expose it through a tunnel you control, and approve the connection with a password only you have.

## Quick Start

DevSpace requires Node `>=20.12 <27`. Node 22 LTS is recommended.

```bash
npx @waishnav/devspace init
npx @waishnav/devspace serve
```

During setup, DevSpace asks for:

- the local project folders ChatGPT is allowed to open through DevSpace
- the local port, usually `7676`
- your public HTTPS base URL from Cloudflare Tunnel, ngrok, Pinggy, Tailscale Funnel, or
  another reverse proxy

Use the public origin without `/mcp` during setup:

```text
https://your-tunnel-host.example.com
```

Then configure your MCP client with:

```text
https://your-tunnel-host.example.com/mcp
```

When the client connects, DevSpace opens an Owner password approval page. Enter
the Owner password printed by `devspace init`. It is also stored in:

```text
~/.devspace/auth.json
```

Keep that password private.

## What ChatGPT Gets

After the MCP client connects, ChatGPT can open a project with
`open_workspace` and then reuse the returned `workspaceId` for later calls.

DevSpace provides tools for:

- reading, writing, and editing files inside the opened workspace
- running shell-backed search and directory inspection in the default minimal tool mode
- running shell commands for tests, builds, git, and package scripts
- opening isolated Git worktrees when you want parallel work
- loading `AGENTS.md` and `CLAUDE.md` instructions
- exposing local agent skills from your skill folders
- showing ChatGPT Apps tool cards, with an opt-in aggregate `show_changes` card

The default local endpoint is:

```text
http://127.0.0.1:7676/mcp
```

Most users should connect through a public HTTPS tunnel:

```text
https://your-tunnel-host.example.com/mcp
```

## Mental Model

DevSpace is remote access to selected local folders.

You decide which roots are allowed. The MCP client still has powerful local
capabilities inside an opened workspace, including shell execution. Treat a
connected client like a trusted coding partner with access to your machine.

For a normal ChatGPT coding session:

1. Start your tunnel.
2. Run `npx @waishnav/devspace serve`.
3. Connect the MCP client to your public `/mcp` URL.
4. Approve the connection with the Owner password.
5. Ask ChatGPT to open a project inside one of your allowed roots.

## Platform Support

DevSpace supports Linux, macOS, and Windows environments with a Bash-compatible
shell.

| Platform                                          | Status            | Notes                                          |
| ------------------------------------------------- | ----------------- | ---------------------------------------------- |
| Linux                                             | Supported         | Requires Node, npm, Git, and Bash.             |
| macOS                                             | Supported         | Requires Node, npm, Git, and Bash.             |
| Windows with Git Bash, WSL, MSYS2, or Cygwin Bash | Supported         | Git Bash is the simplest native Windows setup. |
| Windows PowerShell or `cmd.exe` only              | Not supported yet | Install Git Bash or use WSL.                   |

Run this to inspect your local setup:

```bash
npx @waishnav/devspace doctor
```

## Documentation

- [Setup Guide](docs/setup.md)
- [ChatGPT Coding Workflow](docs/chatgpt-coding-workflow.md)
- [Configuration Reference](docs/configuration.md)
- [Security Model](docs/security.md)
- [Troubleshooting Gotchas](docs/gotchas.md)

## Local Development

For working on DevSpace itself:

```bash
npm install --include=dev
npm run dev
npm run typecheck
npm test
npm run build
npm run start
```
