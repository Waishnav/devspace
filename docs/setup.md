# Setup Guide

This guide covers ChatGPT and Coding Agents using DevSpace with local projects.

## Requirements

- Node `>=22.19 <27`
- npm
- Git
- Bash, including Git Bash or WSL on Windows
- a public HTTPS URL that forwards to the local DevSpace server, only when
  ChatGPT will connect

DevSpace does not create the public tunnel for you. ChatGPT users can use
Cloudflare Tunnel, ngrok, Pinggy, Tailscale Funnel, or their own HTTPS reverse
proxy.

## Install And Configure

Run:

```bash
npx @waishnav/devspace init
```

The setup flow asks one question at a time.

First choose where you will use DevSpace: ChatGPT, Coding Agents, or both.
DevSpace uses that answer to skip setup that does not apply to you.

### Project roots

If you selected ChatGPT, choose the project folders it may open through
DevSpace. Keep this narrow.

Examples:

```text
~/personal,~/work
```

```text
/Users/alice/dev,/Users/alice/work
```

```text
C:\Users\alice\dev,C:\Users\alice\work
```

A Coding Agents-only setup skips this question. Direct `devspace agents`
commands use the current Git project, or the current directory outside a
repository, with the authority of your local shell. MCP workspace operations
remain limited to the roots configured for ChatGPT.

### Coding Agents

Setup detects supported Coding Agents and asks which ones DevSpace may use.
These choices are stored as provider objects under `subagents` in
`~/.devspace/config.json`.

If you selected Coding Agents, setup prints:

```bash
npx skills add Waishnav/devspace --skill subagents --global
```

The Skills CLI asks which installed Coding Agents should receive the skill.
The skill uses `devspace agents targets`, `run`, `continue`, `show`, and `ls`.
These commands do not require `devspace serve`.

### Connect ChatGPT

Setup only asks for a public URL if you selected ChatGPT. Start your tunnel or
reverse proxy first and point it at:

```text
http://127.0.0.1:7676
```

Enter the public origin without `/mcp`:

```text
https://your-tunnel-host.example.com
```

Configure the MCP client with the full MCP endpoint:

```text
https://your-tunnel-host.example.com/mcp
```

A Coding Agents-only setup skips this section.

## Start The Server

Run:

```bash
npx @waishnav/devspace serve
```

If your tunnel URL changes for one run, override it without rewriting config:

```bash
DEVSPACE_PUBLIC_BASE_URL="https://new-tunnel.example.com" npx @waishnav/devspace serve
```

For a stable public URL, persist it:

```bash
npx @waishnav/devspace config set publicBaseUrl https://devspace.example.com
npx @waishnav/devspace serve
```

## Approve The Client

When ChatGPT, Claude, or another MCP client connects, DevSpace shows an Owner
password approval page. Enter the Owner password printed during setup.

The default config files are:

```text
~/.devspace/config.json
~/.devspace/auth.json
```

Keep `auth.json` private.

## Check Your Setup

Run:

```bash
npx @waishnav/devspace doctor
```

The doctor command reports the resolved config, Node version, Node ABI, platform,
Git, Bash, public URL, allowed hosts, and SQLite native dependency status.

## Running From A Local Checkout

If you are developing DevSpace itself instead of using the published package:

```bash
npm install --include=dev
npm run dev
```

The same setup rules apply.
