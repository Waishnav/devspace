# ChatGPT Coding Workflow

DevSpace brings a Codex-style coding-agent loop to ChatGPT and other MCP hosts:
inspect the repo, follow local instructions, make scoped edits, run
verification, and show the user what changed.

## Open One Workspace

ChatGPT should call `open_workspace` once for a project folder:

```json
{
  "path": "~/work/my-project"
}
```

The result includes a `workspaceId`. All later file, search, edit, show-changes,
and shell calls should reuse that same `workspaceId`.

ChatGPT may support automatic checkout recovery through optional host
conversation metadata. This is an OpenAI-host adapter detail, not a standard MCP
conversation field. When that optional context is available, opening the same
checkout project again in the same conversation can continue in the existing
workspace, and the context already provided for that reused checkout is not
repeated. The portable workflow remains the same: keep using the `workspaceId`
returned by `open_workspace` for later operations. Hosts without supported
conversation context receive a normal new workspace and continue with that
explicit `workspaceId` workflow.
The model receives actionable workspace instructions; automatic-reuse
bookkeeping is not a model-facing choice.

Worktree mode is deliberately different: every call creates a new managed
worktree and a new workspace session with complete context, even for the same
path and base ref.

The first successful open of a checkout provides complete instructions and
coding context. A repeated open that reuses the same checkout workspace does
not repeat the model-visible context, but the workspace UI continues to show the
complete details. Every new worktree establishes and returns its own complete
context, even when the same project was already opened in checkout or another
worktree. Opening checkout after a worktree therefore provides the checkout's
own context.

Do not call `open_workspace` again for the same checkout folder unless:

- the `workspaceId` is rejected as unknown
- work moves to a different project folder
- work switches between checkout and worktree mode
- the user asks for a new isolated worktree

## Checkout Mode

Checkout mode is the default. DevSpace opens the actual directory:

```json
{
  "path": "~/work/my-project"
}
```

Use this when the user wants ChatGPT to work in the current checkout.

## Worktree Mode

Use worktree mode for isolated parallel work:

```json
{
  "path": "~/work/my-project",
  "mode": "worktree"
}
```

Managed worktrees are created under:

```text
~/.devspace/worktrees
```

Worktree mode requires a Git repository with at least one commit. It starts from
`HEAD` unless `baseRef` is provided.

Each worktree-mode call creates a new managed worktree and returns a new
`workspaceId`. Reuse that ID for work inside that worktree; call
`open_workspace` in worktree mode again only when another isolated worktree is
actually required.

Uncommitted source checkout changes are not copied into the managed worktree.
DevSpace reports when the source checkout was dirty so the model can decide how
to proceed with the user.

## Project Instructions

When a workspace opens, DevSpace loads root-level instruction files:

- `AGENTS.md`
- `AGENTS.MD`
- `CLAUDE.md`
- `CLAUDE.MD`

Nested instruction files are returned as `availableAgentsFiles`. The model
should read the relevant nested file before working under that directory.

This keeps instructions explicit and inspectable instead of silently injecting
new context during later tool calls.

## Skills

Skills are enabled by default for coding-agent workflows.

DevSpace discovers standard Agent Skills from:

- `~/.agents/skills`
- project `.agents/skills`
- `~/.devspace/skills`

It also keeps compatibility with:

- the bundled `subagents` skill when Subagents are enabled, unless `~/.devspace/skills/subagents/SKILL.md` exists
- `skills.agentDir/skills`, defaulting to `~/.codex/skills`
- additional paths from `skills.paths`

When Subagents are enabled, DevSpace discovers agent profiles
from `~/.devspace/agents/*.md` and project `.devspace/agents/*.md`.
`open_workspace` exposes a compact catalog with profile names, descriptions,
providers, and optional models/effort levels so the model can choose a configured agent
without seeing provider-specific launch details.

Example profiles are packaged under `examples/agents/` for users who want
starter templates. Copy or adapt them into one of the active profile directories
before use.

Legacy project paths such as `.pi/skills` can be added to `skills.paths` when needed.

When `open_workspace` returns matching skills, the model should read the
advertised `SKILL.md` before following that skill.

Skill paths may be outside the workspace. DevSpace only permits reading:

- advertised `SKILL.md` files
- files under a skill directory after that skill's `SKILL.md` has been read

Set `skills.enabled` to `false` to hide skills from workspace output. Enable
Subagents and choose providers through `devspace init` or the persisted provider
configuration. The bundled `subagents` skill teaches the minimal
`devspace agents targets`, `devspace agents ls`, `devspace agents run`,
`devspace agents continue`, `devspace agents show`, and `devspace agents wait`
workflow. The catalog
comes from `open_workspace`; `devspace agents ls` lists existing subagent
sessions for that workspace.

## Tool Names

The Claude surface exposes these tool names:

- `open_workspace`
- `read`
- `write`
- `edit`
- `bash`
- `show_changes`

DevSpace uses the Codex-style surface by default. It exposes:

- `open_workspace`
- `read`
- `apply_patch`
- `exec_command`
- `write_stdin`
- `show_changes`

In this mode, `write`, `edit`, and `bash` are not registered. `exec_command`
returns a process session ID when a command is still
running after its yield window. Use `write_stdin` to poll it, send input, resize
a PTY, or send Ctrl-C. Set `tty: true` only for commands that need a terminal.

Set `tools.mode` to `claude` in `~/.devspace/config.jsonc` to expose `write`,
`edit`, and `bash` instead of the Codex mutation and command tools. Dedicated
MCP tools for `grep`, `glob`, and `ls` are not registered in either mode; use
the configured shell tool with command-line tools such as `rg`, `find`, and
`ls`.

## Show Changes

DevSpace exposes `show_changes` in both tool modes and attaches widget UI only
to `open_workspace` and `show_changes`. Reads, edits, and commands return normal
MCP results without creating an iframe for each call. Set `ui.enabled` to
`false` in `~/.devspace/config.jsonc` to disable UI metadata while keeping the
aggregate review tool available.

Call `show_changes` exactly once after the final file modification in any turn
that changes files. It shows the combined changes for that turn and advances
the review point automatically. Reusing a workspace does not change this
workflow.

The model-facing result stays compact: DevSpace returns the workspace ID, a
Git-backed `reviewRef`, and the summary text. MCP Apps hosts receive the full
file list and patch in result metadata for immediate rendering. If a host later
restores only the structured result, the review card can reopen that exact
`reviewRef` from DevSpace's Git review history without advancing the current
review point.

For local inspection, run `devspace show-changes <review-ref>`. Add `--json` to
include the parsed summary, file list, and patch.

## Shell Use

The shell tool is for commands that belong in a terminal:

- tests
- builds
- git inspection
- package scripts
- environment checks

File writes should go through the edit/write tools rather than shell
redirection, heredocs, `tee`, `sed -i`, or generated scripts.
