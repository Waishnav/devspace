# Troubleshooting Gotchas

This page collects the setup issues users are most likely to hit.

## `devspace` Command Not Found

Use `npx`:

```bash
npx @waishnav/devspace init
npx @waishnav/devspace serve
```

If you installed globally, confirm npm's global bin directory is on `PATH`.

## Unsupported Node Version

DevSpace requires Node `>=22.19 <27`.

Check:

```bash
node --version
```

Install Node 22 LTS with your preferred version manager such as `nvm`, `fnm`, or
`mise`.

## `better-sqlite3` Could Not Load

This usually means native dependencies were installed under a different Node
runtime.

Try:

```bash
npm rebuild better-sqlite3
```

Then run:

```bash
npx @waishnav/devspace doctor
```

Release starts run a native dependency check before launching.

## Public URL Includes `/mcp`

Use the origin for setup:

```text
https://your-tunnel-host.example.com
```

Use the MCP endpoint in the client:

```text
https://your-tunnel-host.example.com/mcp
```

If you saved the wrong value:

```bash
npx @waishnav/devspace config set publicBaseUrl https://your-tunnel-host.example.com
```

## Tunnel URL Changed

Temporary tunnels often change URLs between runs.

For a one-off run:

```bash
DEVSPACE_PUBLIC_BASE_URL="https://new-tunnel.example.com" npx @waishnav/devspace serve
```

For a stable URL:

```bash
npx @waishnav/devspace config set publicBaseUrl https://devspace.example.com
```

## Host Header Or 403 Problems

DevSpace derives allowed hosts from the configured public URL.

Run:

```bash
npx @waishnav/devspace doctor
```

Confirm the public URL hostname appears in allowed hosts. If you changed tunnel
URLs, update `publicBaseUrl`.

Use this only for intentional local debugging:

```bash
DEVSPACE_ALLOWED_HOSTS="*" npx @waishnav/devspace serve
```

## OAuth Redirect Host Rejected

By default, DevSpace allows redirects for:

```text
chatgpt.com
localhost
127.0.0.1
```

If another MCP client uses a different redirect host, configure:

```bash
DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS="chatgpt.com,example.com" npx @waishnav/devspace serve
```

## Owner Password Not Accepted

Make sure you are entering the Owner password from:

```text
~/.devspace/auth.json
```

To regenerate setup:

```bash
npx @waishnav/devspace init --force
```

## Unknown `workspaceId`

`workspaceId` values are session identifiers. If the server restarts and the
client receives an unknown workspace error, call `open_workspace` again for that
project.

Workspace session metadata is persisted, but clients should still treat
`open_workspace` as the way to begin a fresh working session.

## Workspace Path Rejected

The path must be inside one of the allowed roots configured during setup.

Run:

```bash
npx @waishnav/devspace config get
```

Then either open a project under an allowed root or rerun setup:

```bash
npx @waishnav/devspace init --force
```

## Worktree Mode Fails

Worktree mode requires:

- Git installed
- the path is inside a Git repository
- the repository has at least one commit
- the requested `baseRef` resolves to a commit

For a new repository, create the first commit or use checkout mode.

Uncommitted source checkout changes are not copied into the managed worktree.
Commit, stash, or ask the model to work in checkout mode if those changes are
needed.

## Windows Shell Behavior

On Windows, DevSpace uses native PowerShell by default. This avoids routing
commands through Bash/MSYS before PowerShell receives them, which can otherwise
expand PowerShell variables such as `$_` too early.

Run:

```bash
npx @waishnav/devspace doctor
```

Confirm `Shell mode` and `Shell command`.

To force a specific shell:

```powershell
$env:DEVSPACE_SHELL="powershell"; npx @waishnav/devspace serve
$env:DEVSPACE_SHELL="cmd"; npx @waishnav/devspace serve
$env:DEVSPACE_SHELL="bash"; npx @waishnav/devspace serve
```

When writing PowerShell commands that inspect Windows paths, prefer `-like` or
`.Contains()` for literal path fragments. `-match` uses regex, so a path segment
like `\profiles` can be parsed as the regex escape `\p`. If you need regex, wrap
literal paths with `[regex]::Escape($path)`.

DevSpace blocks fragile PowerShell commands that look like literal Windows paths
being passed to `-match`:

```powershell
$_.CommandLine -match "pydoll-mcp-server\profiles\chatgpt-linkedin-check"
$_.Path -match 'C:\Users\Yuri\Documents'
```

Use literal matching instead:

```powershell
$_.CommandLine.Contains("pydoll-mcp-server\profiles\chatgpt-linkedin-check")
$_.CommandLine -like "*pydoll-mcp-server*profiles*chatgpt-linkedin-check*"
```

If you really need `-match`, escape the literal first:

```powershell
$pattern = [regex]::Escape("pydoll-mcp-server\profiles\chatgpt-linkedin-check")
$_.CommandLine -match $pattern
```

Regex patterns that do not look like Windows paths, such as
`'remote-debugging-port=\d+'`, are allowed.

## Skills Do Not Appear

Skills are enabled by default. Check:

```bash
DEVSPACE_SKILLS=1 npx @waishnav/devspace serve
```

DevSpace looks in standard Agent Skills locations:

- `~/.agents/skills`
- project `.agents/skills`
- `~/.devspace/skills`

It also checks compatibility and custom paths:

- the bundled `subagent-delegation` skill when `DEVSPACE_SUBAGENTS=1`, unless `~/.devspace/skills/subagent-delegation/SKILL.md` exists
- `DEVSPACE_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `DEVSPACE_SKILL_PATHS`

When `DEVSPACE_SUBAGENTS=1`, DevSpace loads agent profiles from
`~/.devspace/agents/*.md` and project `.devspace/agents/*.md`, then exposes a
compact profile catalog through `open_workspace`. The bundled
`subagent-delegation` skill keeps the model-facing workflow to
`devspace agents ls`, `devspace agents run`, and `devspace agents show`.
`devspace agents ls` lists existing subagent sessions, not profile
definitions.

Packaged agent profile examples under `examples/agents/` are starter templates.
Copy or adapt them into one of the active profile directories before use.

Legacy project paths such as `.pi/skills` can be added through `DEVSPACE_SKILL_PATHS` when needed.

If a skill appears in `open_workspace`, the model must read that skill's
`SKILL.md` before reading other files inside the skill directory.

## Review Card Does Not Appear

Per-tool widget cards are enabled by default with:

```bash
DEVSPACE_WIDGETS=full
```

The aggregate `show_changes` tool is only exposed with
`DEVSPACE_WIDGETS=changes`. Plain MCP clients may ignore ChatGPT Apps widget
metadata and only show text results.
