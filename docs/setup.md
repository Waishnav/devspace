# Setup Guide

This guide is for users who want ChatGPT or another MCP host to work in local
projects through DevSpace.

## Requirements

- Node `>=22.19 <27`; Node 22.19 or newer is recommended
- npm
- Git
- Bash, including Git Bash or WSL on Windows
- a public HTTPS URL that forwards to the local DevSpace server

DevSpace does not create the public tunnel for you. Use Cloudflare Tunnel,
ngrok, Pinggy, Tailscale Funnel, or your own HTTPS reverse proxy.

## Install And Configure

Run:

```bash
npx @waishnav/devspace init
```

The setup flow asks one question at a time.

### Project Roots

Choose the folders ChatGPT is allowed to open through DevSpace. Keep this
narrow.

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

### Local Listen Address

After the port, `devspace init` asks which local address the server should bind
to. Examples:

```text
127.0.0.1    local machine only
100.64.0.2   a specific Tailscale or network interface
0.0.0.0      every IPv4 interface
```

This does not change the public HTTPS/OAuth URL.

### Public Base URL

If a public URL is already configured, `devspace init --force` defaults to
keeping it unchanged. This is the normal choice when only changing the local
listen address. For a new setup or an intentional URL change, the choices are:

- **Localhost** uses `http://localhost:<port>` and needs no additional URL input.
- **Custom HTTPS URL** waits for a tunnel or reverse-proxy HTTPS origin.

A direct LAN or Tailscale address belongs in the earlier local listen-address
step, not in the OAuth public URL field.

For a custom URL, point the tunnel or reverse proxy at the local server and
enter the client-facing origin without `/mcp`:

```text
https://your-tunnel-host.example.com
```

Configure the MCP client with the full MCP endpoint:

```text
https://your-tunnel-host.example.com/mcp
```

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
