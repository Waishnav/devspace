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

## Installation

DevSpace requires Node `>=20.12 <27`. Node 22 LTS is recommended.

Install the DevSpace CLI:

```bash
npm install -g @waishnav/devspace
```

Then initialize and start the server:

```bash
devspace init
devspace serve
```

Or run it without a global install:

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

You will configure your MCP client with the public `/mcp` URL after setup.

When the client connects, DevSpace opens an Owner password approval page. Enter
the Owner password printed by `devspace init`. It is also stored in:

```text
~/.devspace/auth.json
```

Keep that password private.

## Connect Your MCP Client

The default local endpoint is:

```text
http://127.0.0.1:7676/mcp
```

Most users should connect through a public HTTPS tunnel:

```text
https://your-tunnel-host.example.com/mcp
```

## Configuration Management

Update the local server config with short commands:

```bash
devspace config show
devspace config port 7676
devspace config host 127.0.0.1
devspace config domain devspace.example.com
devspace config key
```

Configuration changes are saved immediately. If a managed DevSpace background
service is currently running, DevSpace automatically restarts it so the new
settings take effect right away.

`devspace config show` displays the effective bind host, port, MCP path, public
URL, workspace list, service state, and a masked access key. If the current
Owner password comes from `DEVSPACE_OAUTH_OWNER_TOKEN`, DevSpace masks and shows
that effective value instead of reporting it as missing.

`devspace config key` rotates the existing DevSpace Owner password, clears saved
OAuth approvals and tokens, and forces connected clients to reauthorize.

## Workspace Management

Persist the workspace roots DevSpace is allowed to open:

```bash
devspace workspace add ~/workspace/project-a --default
devspace workspace add ~/workspace/project-b
devspace workspace list
devspace workspace default ~/workspace/project-b
devspace workspace remove ~/workspace/project-a
```

You can also allow extra paths for one run only:

```bash
devspace serve --add-dir ~/scratch/project-c --workspace ~/workspace/project-b
```

Workspace paths are the authorization boundary for DevSpace and MCP file tools.
Adding a workspace authorizes only that path and its children.

If you start DevSpace without any configured workspaces or `DEVSPACE_ALLOWED_ROOTS`,
DevSpace now fails closed: the server can start, but workspace access is denied
until you explicitly add an allowed path.

## Service Management

DevSpace service management only manages DevSpace itself. `devspace service start`
acts as the single entrypoint: if the background service is missing, DevSpace
creates it for the current platform and starts it; if it already exists, it
just starts it. It does not manage arbitrary system services.

```bash
devspace service start
devspace service status
devspace service logs
devspace service restart
devspace service stop
devspace service disable
devspace service remove
devspace service doctor
```

Platform behavior:

- macOS uses a per-user LaunchAgent.
- Linux and Ubuntu use a per-user systemd service when available.
- Windows uses Task Scheduler.
- WSL prefers user systemd and otherwise reports a Windows Task Scheduler fallback.

DevSpace does not automatically configure DNS, reverse proxies, TLS
certificates, or firewall rules.

## What ChatGPT Can Do

Once connected, ChatGPT can open one of your approved project folders as a
workspace. From there, it can inspect the repo, make scoped edits, run commands,
and show you what changed.

DevSpace gives ChatGPT tools to:

- read, write, and edit files inside the opened workspace
- search code and inspect directories
- run shell commands for tests, builds, git, and package scripts
- use isolated Git worktrees for parallel coding sessions
- follow project instructions from `AGENTS.md` and `CLAUDE.md`
- discover local agent skills from your skill folders
- show tool cards and optional change summaries in ChatGPT Apps-compatible hosts

DevSpace also bundles a small set of built-in workflow and engineering skills.
Their structure is inspired by [alirezarezvani/claude-skills](https://github.com/alirezarezvani/claude-skills), which is released under the MIT license.

Project skill directories are split by purpose:

- system built-in DevSpace skills, committed with DevSpace
- `skills/local`: project-defined skills you want to keep in version control
- `skills/installed`: user-installed project skills, ignored by git by default

ChatGPT Plus on the web cannot natively install or register Codex Skills. DevSpace provides the MCP-side skill installation, discovery, and resolution layer instead.

`@devspace /plan` and `@devspace /goal` are alias-style workflow conventions. They are not native ChatGPT slash commands.

Manage installed skills with:

```bash
devspace skills install --repo openai/skills --path skills/.curated/research
devspace skills install --workspace /path/to/project --repo openai/skills --path skills/.curated/research
devspace skills list
devspace skills list --workspace /path/to/project
devspace skills remove research
devspace skills remove --workspace /path/to/project research

devspace skills install -g --repo openai/skills --path skills/.curated/research
devspace skills list -g
devspace skills remove -g research
```

`--repo/--path` and `--local-path` must point directly at one standard skill directory that contains `SKILL.md`. Repository roots, plugin roots, command folders, and agent-rules directories are rejected.

## Mental Model

DevSpace is remote access to selected local folders.

You decide which roots are allowed. The MCP client still has powerful local
capabilities inside an opened workspace, including shell execution. Treat a
connected client like a trusted coding partner with access to your machine.

For a normal ChatGPT coding session:

1. Start your tunnel.
2. Run `devspace serve`.
3. Connect the MCP client to your public `/mcp` URL.
4. Approve the connection with the Owner password.
5. Ask ChatGPT to open a project inside one of your allowed roots.

## Platform Support

DevSpace supports Linux, macOS, and Windows environments with a Bash-compatible
shell for the main CLI, and supports native per-user service control on macOS,
Linux, Windows, and WSL.

| Platform                                          | Status            | Notes                                          |
| ------------------------------------------------- | ----------------- | ---------------------------------------------- |
| Linux                                             | Supported         | Requires Node, npm, Git, and Bash.             |
| macOS                                             | Supported         | Requires Node, npm, Git, and Bash.             |
| Windows with Git Bash, WSL, MSYS2, or Cygwin Bash | Supported         | Git Bash is the simplest native Windows setup. |
| Windows PowerShell or `cmd.exe` only              | Not supported yet | Install Git Bash or use WSL.                   |

Run this to inspect your local setup:

```bash
devspace doctor
```

## Documentation

- [Setup Guide](docs/setup.md)
- [ChatGPT Coding Workflow](docs/chatgpt-coding-workflow.md)
- [Configuration Reference](docs/configuration.md)
- [Security Model](docs/security.md)
- [Troubleshooting Gotchas](docs/gotchas.md)

## Philosophy

Every piece of software is becoming conversational. Natural language is
redefining how we interact with tools, workflows, and systems.

My bet is that ChatGPT becomes the operating system for everything. Once we
reach AGI, we will simply talk to ChatGPT, and it will prompt, coordinate, and
orchestrate sub-agents that set up the right loops for us.

We are not there yet.

DevSpace is one attempt to fast-forward that future: a way for MCP-capable
hosts like ChatGPT and Claude to work directly with local project files through
explicit, inspectable tools.

## Built by Waishnav

I'm Waishnav, the creator of [GitCMS](https://gitcms.dev/), a Git-backed CMS
for markdown sites.

I like building opinionated products, and DevSpace is another example of that.
I'm on a journey to build a single-person company doing multiple millions in
revenue. If you want to watch the failures, wins, lessons, and everything in
between, come hang out with me on [X](https://x.com/wshxnv).

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
