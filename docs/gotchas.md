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

Update the configured URL:

```bash
npx @waishnav/devspace config set publicBaseUrl https://new-tunnel.example.com
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

For intentional local debugging only, set `server.allowedHosts` to `["*"]` in
`~/.devspace/config.jsonc`.

## OAuth Redirect Host Rejected

By default, DevSpace allows redirects for:

```text
chatgpt.com
localhost
127.0.0.1
```

If another MCP client uses a different redirect host, add it to
`oauth.allowedRedirectHosts` in `~/.devspace/config.jsonc`.

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

Workspace session metadata is persisted. ChatGPT may provide optional
conversation metadata that lets DevSpace resume the same checkout workspace for
the same project in that conversation; repeated opens reuse the `workspaceId`
and do not repeat context already provided for that reused checkout. Worktree
mode always creates a new isolated workspace with its own complete context.
Hosts without supported conversation metadata receive a normal new workspace.
In all cases, continue passing the `workspaceId` returned by `open_workspace` to
later tools. Other MCP hosts use this explicit workspace workflow as well.

To review work, call `show_changes` once after the final related file change. It
shows the combined changes and advances the review point automatically.

## Data Retention

DevSpace does not currently prune workspace sessions, conversation bindings,
or review refs. A future product retention policy will define safe cleanup for
these records; no automatic deletion is performed today.

## MCP Workspace Path Rejected

The path passed to `open_workspace` must be inside one of the allowed roots
configured during ChatGPT setup. Direct `devspace agents` commands instead use
the current local project and are not gated by MCP allowed roots.

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

## Windows Shell Commands Fail

DevSpace shell execution requires Bash. Native PowerShell and `cmd.exe` command
execution are not supported yet.

Install Git for Windows and use Git Bash, or use WSL, MSYS2, or Cygwin Bash.

Run:

```bash
npx @waishnav/devspace doctor
```

Confirm Bash is detected.

## Skills Do Not Appear

Skills are enabled by default. Confirm `skills.enabled` is `true` in
`~/.devspace/config.jsonc`.

DevSpace looks in standard Agent Skills locations:

- `~/.agents/skills`
- project `.agents/skills`
- `~/.devspace/skills`

It also checks compatibility and custom paths:

- the bundled `subagents` skill when Subagents are enabled, unless `~/.devspace/skills/subagents/SKILL.md` exists
- `skills.agentDir/skills`, defaulting to `~/.codex/skills`
- additional paths from `skills.paths`

When Subagents are enabled, DevSpace loads agent profiles from
`~/.devspace/agents/*.md` and project `.devspace/agents/*.md`, then exposes a
compact profile catalog through `open_workspace`. The bundled
`subagents` skill keeps the model-facing workflow to
`devspace agents targets`, `devspace agents ls`, `devspace agents run`,
`devspace agents continue`, `devspace agents show`, and `devspace agents wait`.
Those commands automatically manage the internal local agent daemon; `devspace
serve` is not a prerequisite.
`devspace agents ls` lists existing subagent sessions, not profile
definitions.

For a Coding Agent, run the installation command printed by
`devspace init`:

```bash
npx skills add Waishnav/devspace --skill subagents --global
```

The Skills CLI handles agent discovery and installation. DevSpace setup does
not copy files into agent skill directories.

Packaged agent profile examples under `examples/agents/` are starter templates.
Copy or adapt them into one of the active profile directories before use.

Legacy project paths such as `.pi/skills` can be added to `skills.paths` when needed.

If a skill appears in `open_workspace`, the model must read that skill's
`SKILL.md` before reading other files inside the skill directory.

## Review Card Does Not Appear

DevSpace attaches widget UI only to `open_workspace` and `show_changes`.
Ordinary reads, edits, and commands intentionally render as normal tool results
to avoid one iframe per call. Plain MCP clients may ignore ChatGPT Apps widget
metadata and only show text results; `show_changes` remains available there.

If both cards are missing in ChatGPT, confirm that `ui.enabled` is not `false`
in `~/.devspace/config.jsonc` and reconnect the MCP server.

Historical `show_changes` cards use the `reviewRef` in their structured result
to recover the exact Git-backed review when a host reloads the app without its
original result metadata. `open_workspace` can rebuild its card directly from
its structured result.
