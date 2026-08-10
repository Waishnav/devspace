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

- the bundled `subagent-delegation` skill when `DEVSPACE_SUBAGENTS=1`, unless `~/.devspace/skills/subagent-delegation/SKILL.md` exists
- `DEVSPACE_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `DEVSPACE_SKILL_PATHS`

When Subagents are enabled, DevSpace discovers agent profiles
from `~/.devspace/agents/*.md` and project `.devspace/agents/*.md`.
`open_workspace` exposes a compact catalog with profile names, descriptions,
providers, and optional models/thinking levels so the model can choose a configured agent
without seeing provider-specific launch details.

Example profiles are packaged under `examples/agents/` for users who want
starter templates. Copy or adapt them into one of the active profile directories
before use.

Legacy project paths such as `.pi/skills` can be added through `DEVSPACE_SKILL_PATHS` when needed.

When `open_workspace` returns matching skills, the model should read the
advertised `SKILL.md` before following that skill.

Skill paths may be outside the workspace. DevSpace only permits reading:

- advertised `SKILL.md` files
- files under a skill directory after that skill's `SKILL.md` has been read

Set `DEVSPACE_SKILLS=0` to hide skills from workspace output. Set
`DEVSPACE_SUBAGENTS=1` to expose the experimental subagent catalog and
`subagent-delegation` skill. That skill teaches the minimal
`devspace agents ls`, `devspace agents run`, and `devspace agents show`
workflow. The catalog comes from `open_workspace`; `devspace agents ls` lists
existing subagent sessions for that workspace.

## Tool Names

DevSpace exposes these tool names:

- `open_workspace`
- `read`
- `write`
- `edit`
- `bash`

By default, DevSpace also runs in `DEVSPACE_TOOL_MODE=minimal`, so dedicated
`grep`, `glob`, and `ls` tools are hidden. Use `bash` with command-line tools
such as `rg`, `find`, and `ls` for search and directory inspection.

Use `DEVSPACE_TOOL_MODE=full` to restore dedicated search and directory tools.

The experimental Codex-style surface is enabled with
`DEVSPACE_TOOL_MODE=codex`. It exposes:

- `open_workspace`
- `read`
- `apply_patch`
- `exec_command`
- `write_stdin`

In this mode, `write`, `edit`, `bash`, `grep`, `glob`, and `ls` are not
registered. `exec_command` returns a process session ID when a command is still
running after its yield window. Use `write_stdin` to poll it, send input, resize
a PTY, or send Ctrl-C. Set `tty: true` only for commands that need a terminal.

## Show Changes

By default, `DEVSPACE_WIDGETS=full`.

In that mode, DevSpace attaches widget UI to the exposed workspace, file, edit,
and shell tools. The aggregate `show_changes` tool is not exposed by default.

Use `DEVSPACE_WIDGETS=off` to disable widget UI, or `DEVSPACE_WIDGETS=changes`
to expose the aggregate show-changes flow.

When `show_changes` is exposed, call it exactly once after the final file
modification in any turn that changes files. It shows the combined changes for
that turn and advances the review point automatically. Reusing a workspace does
not change this workflow.

## Shell Use

The shell tool is for commands that belong in a terminal:

- tests
- builds
- Git operations, including inspection and `git add`, `git commit`, `git fetch`,
  `git pull`, and `git push`
- package scripts
- environment checks

This guidance does not authorize destructive Git commands such as
`git reset --hard`, `git clean`, `git checkout --`, or branch deletion. Outside
the explicitly allowed Git operations, project source file writes should go
through the edit/write tools rather than shell redirection, heredocs, `tee`,
`sed -i`, or generated scripts.
