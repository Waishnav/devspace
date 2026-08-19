# Setup Guide

This guide covers both local coding harnesses that use the DevSpace CLI and MCP
hosts such as ChatGPT or Claude.

## Requirements

- Node `>=22.19 <27`
- npm
- Git
- Bash, including Git Bash or WSL on Windows
- a public HTTPS URL only when a remote MCP host must reach DevSpace

DevSpace does not create a public tunnel. Remote MCP users can use Cloudflare
Tunnel, ngrok, Pinggy, Tailscale Funnel, or their own HTTPS reverse proxy.

## Install And Configure

Run:

```bash
npx @waishnav/devspace init
```

The setup flow asks one question at a time.

### Project Roots

Choose the folders DevSpace is allowed to open. Keep this narrow.

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

### Local Port

The default is `7676`.

The local MCP URL is:

```text
http://127.0.0.1:7676/mcp
```

### Public Base URL

Setup first asks whether ChatGPT or Claude will connect over the internet. Say
no for CLI-only use. If yes, start your tunnel or reverse proxy and point it at:

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

### Agent Tooling

Enable agent tooling to use both direct subagents and Dynamic Workflows. Setup
shows currently available providers and persists only the providers you select.
Unavailable and unselected providers are not exposed to models.

The two model skills are installed in:

```text
~/.devspace/skills/subagents
~/.devspace/skills/dynamic-workflows
```

DevSpace updates its managed copies on later forced setup runs and preserves a
same-named directory that does not carry the DevSpace management marker.

Coding harnesses can now run `devspace agents` and `devspace workflow` from a
project directory without starting the MCP server.

## Start The Server

This step is only required for MCP clients.

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
