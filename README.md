# DevSpace

Expose a secure local coding workspace through a Streamable HTTP MCP server.

DevSpace connects MCP-capable hosts such as ChatGPT or Claude to a local
development machine. The host calls MCP tools directly; work is not delegated to
a separate local agent loop.

## Tool Naming Modes

Default tool naming is controlled by `DEVSPACE_TOOL_NAMING`.

Legacy naming, the current default:

- `open_workspace`
- `read_file`
- `write_file`
- `edit_file`
- `grep_files`
- `find_files`
- `list_directory`
- `run_shell`

Short naming, enabled with `DEVSPACE_TOOL_NAMING=short`:

- `open_workspace`
- `read`
- `write`
- `edit`
- `grep`
- `glob`
- `ls`
- `bash`

Set `DEVSPACE_TOOL_MODE=minimal` to disable the dedicated search/list tools. In
that mode, the server instructs clients to use the shell tool with command-line
programs such as `grep`, `rg`, `find`, `ls`, and `tree` for search and directory
inspection.

`DEVSPACE_WIDGETS` controls ChatGPT Apps widget iframe usage. `changes`, the
default, exposes `review_changes` and only attaches widget UI to `open_workspace`
and that aggregate review tool. Use `full` to restore legacy per-tool cards for
debugging without the aggregate review tool, or `off` to disable widget UI entirely.

Server-level workflow guidance is exposed through MCP initialize instructions,
not a dedicated info tool.

## Persistent Result Payloads

Tool result payloads are persisted in a global SQLite database under
`~/.local/share/devspace/devspace.sqlite`, or under `DEVSPACE_STATE_DIR` when
that variable is set. This lets UI cards such as edit/write diff viewers reload
historical payloads after the MCP server process restarts.

Workspace IDs remain live-session identifiers; after a restart, open the
workspace again for new file, edit, search, or shell tool calls.

## Workspace Flow

Call `open_workspace` before using the coding tools:

```json
{
  "path": "~/personal/my-project"
}
```

Absolute paths such as `/home/waishnav/personal/my-project` are also supported.
By default, DevSpace opens the actual checkout. For isolated parallel work in an
existing Git repository, request a managed worktree:

```json
{
  "path": "~/personal/my-project",
  "mode": "worktree"
}
```

Managed worktrees are created under `~/.devspace/worktrees` by default, with
paths such as `~/.devspace/worktrees/my-project-a7f3c9d2`. Worktree mode requires
an initialized Git repository with at least one commit. It does not copy
uncommitted source checkout changes in the first version; the tool result notes
when the source checkout was dirty.

The result includes a `workspaceId`. Use that `workspaceId` for subsequent
calls:

```json
{
  "workspaceId": "ws_...",
  "path": "README.md"
}
```

When a workspace opens, the server loads global and workspace-root context files
such as `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, and `CLAUDE.MD`. It also returns
nested instruction file paths in `availableAgentsFiles`. Later file, list,
search, edit, write, and shell calls do not inject nested instructions
automatically; the model should use the read tool to inspect a listed nested
instruction file before working under that path.

```json
{
  "agentsFiles": [{ "path": "AGENTS.md", "content": "..." }],
  "availableAgentsFiles": [{ "path": "apps/web/AGENTS.md" }]
}
```

## Skills

Skills are disabled by default. Set `DEVSPACE_SKILLS=1` to expose Agent Skills
through `open_workspace` output. DevSpace uses Pi's skill loader to discover
skills from `DEVSPACE_AGENT_DIR` (`~/.pi/agent` by default), project `.pi/skills`,
and optional comma-separated `DEVSPACE_SKILL_PATHS` for locations such as
`~/.agents/skills`, `~/.codex/skills`, or `~/.claude/skills`.

When enabled, `open_workspace` returns a structured catalog of skill names,
descriptions, and readable `SKILL.md` paths. The model should use the normal
read tool to load a matching skill path before following that skill. Skill paths
may be outside the workspace, but read access is limited to advertised `SKILL.md`
files and files under a skill directory after that skill's `SKILL.md` has been
read.

## Run Locally

```bash
npm install --include=dev
npm run typecheck
npm run build

DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)" \
DEVSPACE_ALLOWED_ROOTS="/home/waishnav/personal,/home/waishnav/work" \
DEVSPACE_ALLOWED_HOSTS="localhost,127.0.0.1,agent.gitcms.blog" \
DEVSPACE_PUBLIC_BASE_URL="https://agent.gitcms.blog" \
DEVSPACE_WORKTREE_ROOT="/home/waishnav/.devspace/worktrees" \
DEVSPACE_SKILLS="1" \
DEVSPACE_SKILL_PATHS="/home/waishnav/.codex/skills,/home/waishnav/.claude/skills" \
DEVSPACE_TOOL_MODE="full" \
DEVSPACE_TOOL_NAMING="legacy" \
DEVSPACE_WIDGETS="changes" \
npm run dev
```

## Automatic Git Commits

DevSpace can optionally create background git commits after successful mutating
MCP tool calls. This feature is disabled by default and never blocks normal tool
responses.

Enable it with:

```bash
DEVSPACE_AUTOCOMMIT="on" \
DEVSPACE_AUTOCOMMIT_AFTER="8"
```

Autocommit counts successful `write`, `edit`, and shell tool calls only. Read,
search, list, and workspace-opening calls do not count toward the threshold. When
the threshold is reached, DevSpace captures hidden checkpoint refs, diffs the
current checkpoint against the workspace baseline, asks the configured provider
for structured commit metadata, validates the diff is stable, and performs the
git commit itself.

Providers reuse local auth/config. `DEVSPACE_AUTOCOMMIT_PROVIDER` accepts one
provider, either `codex` or `pi`, with no fallback chain. When autocommit is
enabled and no provider is configured, DevSpace uses `codex`. The `codex`
provider uses the local `codex exec` command in a read-only sandbox with
structured output. The `pi` provider uses Pi with all tools disabled; when
`DEVSPACE_AUTOCOMMIT_MODEL` is set for Pi, use `provider/model` format. DevSpace
does not add API key environment variables for either provider.

Safety rules in the first version:

- requires an existing Git repository with a HEAD commit
- does not run `git init` or create the first commit
- pauses when pre-existing staged changes are detected
- skips pre-existing dirty or untracked paths
- skips untracked files by default
- stages only safe DevSpace-owned paths
- skips instead of committing when the provider fails or returns invalid metadata

Additional optional settings:

```bash
DEVSPACE_AUTOCOMMIT_INCLUDE_UNTRACKED="false"
DEVSPACE_AUTOCOMMIT_MAX_DIFF_BYTES="200000"
DEVSPACE_AUTOCOMMIT_REF_PREFIX="refs/devspace/autocommit"
DEVSPACE_AUTOCOMMIT_PROVIDER="codex"
DEVSPACE_AUTOCOMMIT_MODEL="gpt-5.3-codex-spark"
DEVSPACE_AUTOCOMMIT_CODEX_REASONING_EFFORT="low"
DEVSPACE_AUTOCOMMIT_CODEX_FAST="false"
```

## Release Builds

Use release builds for long-running MCP server processes:

```bash
npm run release:build

env \
  DEVSPACE_OAUTH_OWNER_TOKEN="your-long-random-owner-token" \
  DEVSPACE_ALLOWED_ROOTS="/home/waishnav/personal,/home/waishnav/work" \
  DEVSPACE_ALLOWED_HOSTS="localhost,127.0.0.1,agent.gitcms.blog" \
  DEVSPACE_PUBLIC_BASE_URL="https://agent.gitcms.blog" \
  DEVSPACE_WORKTREE_ROOT="/home/waishnav/.devspace/worktrees" \
  DEVSPACE_TOOL_MODE="minimal" \
  DEVSPACE_TOOL_NAMING="short" \
  npm run release:start
```

The `DEVSPACE_*` assignments must be part of the same command invocation, or
exported first. Running each assignment as a separate shell command will not pass
those values to `npm run release:start`.

`release:build` runs the normal build, copies the built `dist/` tree into a new
`releases/<release-id>/dist` directory, and updates `releases/current` to point
at that immutable copy. A server already running from `npm run release:start`
continues to use its existing release while normal development builds can keep
rewriting `dist/`.

The regular `npm run build` and `npm run start` commands are still useful for
local development and smoke testing. For production-style long-running servers,
prefer `release:build` followed by restarting `release:start`.

The MCP endpoint is:

```text
http://127.0.0.1:7676/mcp
```

DevSpace now uses an embedded single-user OAuth flow instead of the old static
`DEVSPACE_TOKEN` bearer-token check. MCP clients discover OAuth metadata from:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

When ChatGPT opens the authorization URL, DevSpace shows a local owner-token
approval screen. Enter `DEVSPACE_OAUTH_OWNER_TOKEN` there to approve the
connection. The issued OAuth access token is short-lived, resource-bound to the
configured `/mcp` endpoint, and must be sent by the MCP client as a normal
`Authorization: Bearer <oauth-access-token>` header.

## Cloudflare Tunnel

Point a Cloudflare Tunnel hostname at the local server:

```text
http://127.0.0.1:7676
```

Then configure the remote MCP client with:

```text
https://your-tunnel-hostname.example.com/mcp
```

## Security Notes

This server exposes local filesystem and shell capabilities. Treat it like
remote code execution on this machine.

- Always set a long random `DEVSPACE_OAUTH_OWNER_TOKEN`; generate one with `openssl rand -base64 32`.
- Keep `DEVSPACE_ALLOWED_ROOTS` narrow.
- If you expose the server through a tunnel, add the tunnel hostname to `DEVSPACE_ALLOWED_HOSTS`.
- Put Cloudflare Access or equivalent in front of the tunnel before exposing it when possible; OAuth still protects the MCP endpoint if the tunnel URL leaks.
- The shell tool can escape filesystem allowlists by design; shell access relies
  on authentication and client trust, not path containment.
