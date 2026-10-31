<p align="center">
  <picture>
    <img src="https://raw.githubusercontent.com/Waishnav/devspace/main/.github/assets/devspace-logo.png" alt="DevSpace logo" width="140">
  </picture>
</p>

<h1 align="center">DevSpace</h1>

<p align="center">Give ChatGPT, Claude, and Grok Bot your computer. Let any coding agent hand work to any other.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@waishnav/devspace"><img alt="npm" src="https://img.shields.io/npm/v/%40waishnav%2Fdevspace?style=flat-square" /></a>
  <a href="https://github.com/Waishnav/devspace/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Waishnav/devspace/ci.yml?style=flat-square&branch=main" /></a>
  <a href="https://github.com/Waishnav/devspace/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/npm/l/%40waishnav%2Fdevspace?style=flat-square" /></a>
</p>

[![DevSpace connected to ChatGPT](https://raw.githubusercontent.com/Waishnav/devspace/main/.github/assets/devspace-screenshot.png)](https://raw.githubusercontent.com/Waishnav/devspace/main/.github/assets/devspace-screenshot.png)

DevSpace is the agent-agnostic layer between the AI you talk to and the coding
agents on your machine. It does two things:

- **Connects MCP hosts to your machine.** ChatGPT, Claude, and proactive agents
  like Grok Bot, OpenClaw, and Hermes open a workspace, read and edit files, run
  your tests, and show you a review card of the diff — against your real
  checkout, through a tunnel you own.
- **Lets agents delegate to each other.** Codex, Claude Code, OpenCode, Pi,
  Cursor, Copilot, and Grok Build run as subagents of whichever agent is in
  charge, using the CLIs and subscriptions you already have. Parallel writers
  get their own Git worktrees.

Your agent stays the orchestrator: DevSpace never runs a hidden agent loop of
its own. And there is no DevSpace service — everything runs locally with your
credentials.

## Sponsors and Special Thanks
<!-- 

<table>
  <thead>
    <tr>
      <th>Sponsor</th>
      <th>About</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center" width="220">
        <a href="https://rebates.ai/">
          <img
            src="https://app.rebates.ai/brand/rebates-lockup.svg"
            alt="Rebates"
            width="170"
          >
        </a>
      </td>
      <td>
        <strong>The ads in your terminal pay you.</strong><br><br>
        <a href="https://rebates.ai/">Rebates</a> adds one optional
        sponsored footer to your coding agent and pays you cash back for every
        session in which it is shown. Turn it off at any time.
      </td>
    </tr>
  </tbody>
</table>
-->
<p>
  DevSpace is open to new sponsors.
  <a href="https://x.com/wshxnv">Get in touch to become one.</a>
</p>

## Installation

macOS, Linux, and WSL:

```bash
curl -fsSL https://devspace.run/install | sh
```

Windows (DevSpace also needs Git Bash):

```powershell
powershell -c "irm https://devspace.run/install.ps1 | iex"
```

The installer uses a compatible Node (`>=22.19 <27`) on your `PATH` or
downloads Node 24 LTS for DevSpace alone, installs without `sudo`, and starts
`devspace init`. Rerun it to update. If you manage Node yourself,
`npm install -g @waishnav/devspace` followed by `devspace init` also works.

`devspace init` asks where you will use DevSpace and which agents it may run as
subagents. Each question can also be answered with a flag, so scripts and
agents can set it up without prompts:

```bash
devspace init --yes                                                      # subagents only
devspace init --public-url https://your-tunnel.example.com --roots ~/work # also serve an MCP host
```

**Let your agent set itself up.** The **Copy prompt** button on
[devspace.run](https://devspace.run) copies a prompt you can paste into Codex,
Claude Code, or any agent with a shell. It installs, configures, and checks
DevSpace without asking you anything.

## Use It from Your Coding Agents

Subagents need no server, tunnel, or OAuth. Install the skill that teaches your
agent the workflow, then delegate:

```bash
devspace agents skill --install <claude-code|codex|opencode|agents>
# Cursor: devspace agents skill --install cursor --project

devspace agents run codex "Review the staged diff for correctness"
devspace agents run pi "Check the staged diff for test gaps"
devspace agents wait <id> <id>
```

- **Profiles** turn your "which model for which job" choices into named roles
  (`planner`, `reviewer`, …) as Markdown files you own.
- **Worktrees** (`--worktree`) let agents edit in parallel without touching
  your checkout.
- **Dynamic workflows** (experimental, `DEVSPACE_EXPERIMENTAL_WORKFLOWS=1`) let
  the orchestrator write a small, resumable script with `agent()`,
  `parallel()`, `pipeline()`, and `phase()` instead of prompting step by step.

## Use It from ChatGPT, Claude, and Other MCP Hosts

Start a tunnel (Cloudflare Tunnel, ngrok, Pinggy, Tailscale Funnel, or your
own HTTPS reverse proxy) to `http://127.0.0.1:7676`, run `devspace serve`, and
add the public `/mcp` URL as a connector in your host:

```text
https://your-tunnel-host.example.com/mcp
```

When the host connects, DevSpace opens an Owner password approval page. The
password is stored in `~/.devspace/auth.json`; keep it private. The `/mcp`
endpoint serves the 2026-07-28 protocol and older 2025-era clients without any
configuration.

Once connected, the host can open one of your allowed project folders as a
workspace and:

- read, write, and edit files, and search code
- run shell commands for tests, builds, Git, and package scripts
- use isolated Git worktrees for parallel sessions
- follow project instructions from `AGENTS.md` and `CLAUDE.md`, and discover
  your skills
- show a change-review card at the end of a turn
- delegate to your coding agents through the same `devspace agents` CLI

> [!NOTE]
> Using DevSpace as an MCP connector isn't against OpenAI's Usage Policies — it's
> a standard custom App/connector setup, and writing or running code isn't a
> restricted use case. But your account is governed by your usage, not by
> DevSpace. Don't point it at anything that would violate your provider's terms.
> Used normally, you're fine. (Based on OpenAI's Usage Policies and Service Terms
> as of June 2026.)

## Mental Model

DevSpace is remote access to selected local folders, plus a way for your
agents to work together.

You decide which roots an MCP host may open. Inside a workspace the host has
powerful local capabilities, including shell execution, so treat a connected
host like a trusted coding partner with access to your machine. Subagents run
with your local user's authority and logins, scoped to the project they are
started from.

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
devspace doctor
```

## Documentation

Full documentation lives at [devspace.run/docs](https://devspace.run/docs):

- [Quickstart](https://devspace.run/docs/quickstart)
- [Connect ChatGPT, Claude, Grok Bot, and other MCP hosts](https://devspace.run/docs/connect/mcp-hosts)
- [Use DevSpace from Codex, Claude Code, Cursor, OpenCode, and bots](https://devspace.run/docs/connect/coding-agents)
- [Subagents](https://devspace.run/docs/orchestration/subagents) and [agent profiles](https://devspace.run/docs/orchestration/profiles)
- [Dynamic workflows](https://devspace.run/docs/orchestration/dynamic-workflows)
- [CLI reference](https://devspace.run/docs/reference/cli) and [configuration reference](https://devspace.run/docs/reference/configuration)
- [Security model](https://devspace.run/docs/concepts/security)
- [Troubleshooting](https://devspace.run/docs/reference/troubleshooting)

## Philosophy

Every piece of software is becoming conversational, and every provider is
racing to make _their_ agent the orchestrator.

In practice, people already pick a different model and harness per task: one
to plan, another to implement, a cheap one to explore, a second vendor to
review. That matrix is personal, and it changes every few weeks.

DevSpace keeps it yours. Whichever agent you talk to — ChatGPT, Claude, Grok
Bot, or a coding agent in your terminal — can reach your machine and hand work
to the others, through explicit, inspectable tools instead of one vendor's
closed loop.

## Built by Waishnav

I'm Waishnav. I like building opinionated products and tools, and DevSpace is one example.

This year, I began my journey to build a one-person, multi-agent company capable of generating millions in revenue. If you want to follow the failures, wins, lessons, and everything in between, come hang out with me on [X](https://x.com/wshxnv).


## More from me

<table>
  <thead>
    <tr>
      <th>Project</th>
      <th>About</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center" width="220">
        <a href="https://gitcms.dev/">
          <img
            src="https://gitcms.dev/brand/gitcms-logo.svg"
            alt="GitCMS"
            width="48"
          /><br />
          <strong>GitCMS</strong>
        </a>
      </td>
      <td>
        <strong>The CMS for code-first and AI-built websites.</strong><br><br>
        GitCMS gives your team, your clients, and AI agents one safe place to
        edit, review, and publish website changes, while everything stays in
        your site’s repository. No migration and no content database.
        <a href="https://gitcms.dev/">Learn more</a>.
      </td>
    </tr>
  </tbody>
</table>

## Local Development

For working on DevSpace itself:

Install pnpm 11.25.0, the version pinned in `package.json`, with
`npm install --global pnpm@11.25.0`, then:

```bash
pnpm install --frozen-lockfile
pnpm dev:seed
pnpm dev
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

`dev:seed` forks your normal DevSpace config and SQLite state into an ignored
checkout-local `.devspace-dev/` directory so source builds and migrations do not
modify your normal installation. Use `pnpm dev:reset` to discard that QA state
and fork it again. See [DEVELOPMENT.md](DEVELOPMENT.md) for worktree
switching, real-host QA, and database-migration workflows.
