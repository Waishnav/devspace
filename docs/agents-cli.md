# Agents CLI

`devspace agents` lets one coding agent, or a script, orchestrate other coding
agents on the same machine. It needs no MCP server, tunnel, or OAuth setup:
install the package, and the agents you already have installed are the targets.

```bash
npm i -g @waishnav/devspace    # Node 22.19 or newer
cd your-project
devspace agents targets
devspace agents run claude --write-mode read_only --wait --timeout 120 "Summarize what src/cli.ts does"
```

Agents are scoped to the git repository of the directory you run from. A small
background daemon (`devspace-agentd`) starts on demand, owns the running agents,
and exits when idle, so a started agent keeps working after the command that
started it returns.

## Targets

`devspace agents targets` lists what can run:

```xml
<provider name="codex"/>
<provider name="claude"/>
<unavailable name="cursor">cursor-agent executable not found; install it or set CURSOR_COMMAND</unavailable>
```

With no `subagents` section in `~/.devspace/config.jsonc`, DevSpace tries every
built-in provider (`codex`, `claude`, `opencode`, `pi`, `cursor`, `copilot`,
`grok`) and reports the ones it cannot run, with the reason. Each runs with the
CLI's own default model; pass `--model` and `--effort` to override. A provider
is available when its executable is on `PATH`, or named by `CODEX_COMMAND`,
`CURSOR_COMMAND`, `COPILOT_COMMAND`, `GROK_COMMAND`, `CLAUDE_COMMAND`,
`OPENCODE_COMMAND`, or `PI_COMMAND`. Claude and Pi also ship inside the package. DevSpace checks that a
provider can start, not that you are signed in to it.

Configuring `subagents` explicitly replaces that detection. `"enabled": false`
turns subagents off, and `targets` then prints `<disabled>`. Removing the key
brings detection back. See [Configuration](configuration.md#skills-and-subagents)
for providers, models, and profiles.

## Commands

| Command | Purpose |
| --- | --- |
| `targets` | List runnable providers and profiles, and why others are unavailable. |
| `run <target> "<brief>"` | Start an agent and print its id. |
| `wait <id>... [--timeout <s>]` | Block until the agents finish, or the timeout passes. |
| `show <id>` / `ls` | Snapshot of one agent / agents for this project. |
| `events <id> [--follow]` | What the current turn did: tool calls and messages. |
| `continue <id> "<brief>"` | Send a follow-up to the same agent. |
| `stop <id>` | Stop the active turn. The record is kept as `stopped`. |
| `skill [--install <agent>]` | Print or install instructions for other coding agents. |
| `daemon <status\|stop\|logs>` | Diagnose or stop the background daemon. |

`run` and `continue` accept `--model`, `--effort`, `--write-mode`, `--wait`, and
`--timeout`. `run` also accepts `--request-id`, `--worktree`, and `--branch`.

### Single-shot use

`--wait` starts and waits in one command. Always pass `--timeout` in scripts.

```bash
devspace agents run codex --write-mode read_only --wait --timeout 300 --json "Review the staged diff"
```

If the timeout passes, the agent is **not** stopped. The output carries its id;
call `devspace agents wait <id> --timeout 300` again, or `stop <id>`. Interrupting
the CLI (Ctrl-C) also leaves the agent running.

### Exit codes

`run --wait`, `continue --wait`, and `wait` exit with:

| Code | Meaning |
| --- | --- |
| 0 | completed |
| 1 | command error: bad usage, unknown or unavailable target, workspace conflict, daemon failure |
| 2 | the agent failed |
| 3 | the agent was stopped |
| 4 | the wait timed out; the agent is still running |

When waiting on several ids, the worst outcome wins: 2, then 3, then 4. Without
`--wait`, `run` exits 0 once the agent has started.

### Safe retries

`--request-id <key>` makes `run` idempotent. A second `run` with the same key,
project, target, brief, and options returns the existing agent instead of
starting another, which is what a bot wants after a dropped SSH connection. The
key (letters, digits, `. _ : -`, up to 128 characters) becomes the agent id, so
use something unique per job, such as `nightly-2026-08-21`. The same key with
different arguments fails with `AGENT_CONFLICT`.

### Parallel writing agents

Agents run in your checkout by default, so two agents that write, or an agent
and you, can overwrite each other. `--worktree` gives an agent its own
[git worktree](https://git-scm.com/docs/git-worktree) on a new branch, so
parallel agents cannot collide and each hands back something you can review:

```bash
devspace agents run claude --worktree --write-mode allowed "Add retries to src/fetch.ts"
devspace agents run codex  --worktree --branch fix/flaky-test "Fix the flaky retry test"
```

```text
<agent id="agt_1a2b3c4d" status="running" turn="trn_5e6f7a8b" worktree="/home/you/.devspace/worktrees/app-9c8d7e6f" branch="devspace/agt_1a2b3c4d"/>
```

- The worktree is created from the **committed `HEAD`** of the checkout you ran
  from. Uncommitted changes there, staged or not, are **not** copied; commit or
  stash first if the agent needs them.
- It lives under `workspaces.worktreeRoot` (default `~/.devspace/worktrees`) as
  `<repo>-<8 hex>`. The branch is `devspace/<agent id>` unless you pass
  `--branch`, which must not already exist. A `:` in a `--request-id` becomes `-`
  in the default branch name.
- `worktree` and `branch` appear on `run`, `continue`, `show`, `wait`, and `ls`
  output, in XML and in `--json`. `continue` reuses the same worktree and branch.
  Agents stay listed under the checkout they were started from.
- With `--request-id`, a retry returns the existing agent and creates no second
  worktree. The same key with a different `--branch`, or without `--worktree`,
  is an `AGENT_CONFLICT`.
- Outside a git repository, or in one with no commits, `--worktree` fails with
  `WORKTREE_NOT_GIT_REPOSITORY` or `WORKTREE_CREATE_FAILED`. An existing branch
  name also fails with `WORKTREE_CREATE_FAILED`, and no agent is created.

DevSpace never merges or deletes these worktrees; `devspace worktrees prune`
ignores them too. When an agent finishes, review its work with git, from your
checkout:

```bash
git -C <worktree> status                 # what the agent left, committed or not
git -C <worktree> diff                   # uncommitted changes
git log main..devspace/agt_1a2b3c4d      # commits, if the agent made any
git -C <worktree> add -A && git -C <worktree> commit -m "Add retries"   # keep uncommitted work
git merge devspace/agt_1a2b3c4d          # take it
git worktree remove <worktree>           # then clean up (--force if files remain)
git branch -d devspace/agt_1a2b3c4d
```

Whether an agent can commit depends on its write mode and provider sandbox, so
expect uncommitted changes. If you remove a worktree and then `continue` its
agent, the command fails with `WORKTREE_MISSING`; the branch is kept, and
`git worktree add <worktree> <branch>` brings the agent's checkout back.

A worktree isolates files, not authority. The agent still runs as you, and with
`full_access` can reach your original checkout by absolute path.

### Output

Output is compact XML for models by default and one JSON value per command with
`--json`:

```text
$ devspace agents run claude --wait "Reply with exactly PONG"
<agent id="agt_1a2b3c4d" status="completed" turn="trn_5e6f7a8b">PONG</agent>

$ devspace agents run claude --wait --json "Reply with exactly PONG"
{"id":"agt_1a2b3c4d","status":"completed","response":"PONG","turnId":"trn_5e6f7a8b"}
```

`status` is `running`, `completed`, `failed`, or `stopped`. An agent started with
`--worktree` adds `worktree` and `branch` (attributes in XML). A failure adds
`error: {code, message, retryable, detail?}`; an unfinished wait adds
`wait: "timeout"`. Command errors print `{"error":{"code","message","retryable",...}}` and exit 1.
`wait` prints an array of observations, `run`/`continue` without `--wait` print
`{id,status,turnId}`, and `targets` prints `{enabled,targets,unavailable}`.

## Use it from a coding agent

Give the agent the instructions it needs. `devspace agents skill` prints a
portable `SKILL.md`; `--install` writes it where the agent looks for skills:

```bash
devspace agents skill --install claude-code             # ~/.claude/skills/devspace-agents/SKILL.md
devspace agents skill --install claude-code --project   # .claude/skills/devspace-agents/SKILL.md
```

| Agent | Global location | `--project` location |
| --- | --- | --- |
| `claude-code` | `~/.claude/skills/devspace-agents/SKILL.md` | `.claude/skills/devspace-agents/SKILL.md` |
| `codex` | `~/.codex/skills/devspace-agents/SKILL.md` (`$CODEX_HOME`) | `.agents/skills/devspace-agents/SKILL.md` |
| `opencode` | `~/.config/opencode/skills/devspace-agents/SKILL.md` | `.opencode/skills/devspace-agents/SKILL.md` |
| `cursor` | none; Cursor user rules are not files | `.cursor/rules/devspace-agents.mdc` |
| `agents` | `~/.agents/skills/devspace-agents/SKILL.md` | `.agents/skills/devspace-agents/SKILL.md` |

`agents` is the shared Agent Skills directory that OpenCode and Codex also read.
`--project` installs relative to the git root of the current directory. The
skill text comes from the installed package, so reinstall it after upgrading
DevSpace. If you use DevSpace through an MCP host such as ChatGPT, you do not
need this: DevSpace manages the equivalent `subagents` skill itself.

Then ask the agent to delegate, for example "have codex review this diff, read
only". The agent runs the same commands as above.

## Use it from a bot or scheduled job

Install the package on the machine that holds the code and the agent CLIs, then
call it over SSH or from cron. Use `--json`, `--request-id`, and `--timeout`:

```bash
ssh builder 'cd ~/src/app && devspace agents run claude \
  --request-id "nightly-$(date +%F)" --write-mode read_only \
  --wait --timeout 900 --json "Review yesterday'"'"'s commits for security issues"'
echo $?   # 0 done, 2 failed, 3 stopped, 4 still running
```

On exit code 4, call `devspace agents wait <id> --timeout 900 --json` with the
id from the output. Each machine has its own agents and state; the CLI never
talks to another machine, so run it where the work should happen. Provider
credentials come from the user the command runs as, so a non-interactive SSH
session needs the same logins and environment variables as an interactive one.

## Security

Subagents run with the **local user's authority**. They can read files, run
commands, and use the credentials and network that user has. `--write-mode`
narrows this, but it is not a general sandbox:

| Mode | Meaning |
| --- | --- |
| `read_only` | The agent may read and search but not modify files. |
| `allowed` (default) | The agent may edit files in the project, sandboxed where the provider supports it. |
| `full_access` | No sandbox. Use only for work you would run yourself unattended. |

How strictly a mode is enforced depends on the provider. Generic ACP providers
cannot enforce `read_only` or `allowed` and run only with `full_access`. A
follow-up can lower a mode but never raise it. Prefer `read_only` for review,
research, and verification, and treat a brief that comes from untrusted input
(an issue, a web page) like a command someone else wrote.

Agent state is local: the daemon listens on a private socket or named pipe in
DevSpace's state directory, not on a network port.

## Troubleshooting

- **`<unavailable ...>` in `targets`.** The reason names what is missing. Install the
  CLI, put it on `PATH` for the shell that runs `devspace`, or point to it with the
  `*_COMMAND` variable (for example `CURSOR_COMMAND=/opt/bin/cursor-agent`).
- **`<disabled>` in `targets`.** `subagents.enabled` is `false` in
  `config.jsonc`. Remove the `subagents` key to detect agents, or set it to `true`.
- **A provider is listed but fails to start.** Availability does not check
  sign-in. Run the provider's own CLI once to log in, then retry. Failures carry
  the provider's explanation in `<cause>` (`detail` in JSON).
- **`AGENT_CONFLICT`.** The `--request-id` was already used with a different
  project or arguments, or `continue` tried to raise the write mode.
- **The wrong project.** Agents belong to the git root of the directory you
  run from. Run `devspace agents ls` from that project, not from the agent's
  worktree.
- **`--worktree` agent cannot see my uncommitted changes.** The worktree starts from
  the committed `HEAD`. Commit first.
- **The daemon seems stuck.** `devspace agents daemon status`, then
  `devspace agents daemon logs`. `devspace agents daemon stop` asks it to exit;
  agents that were running are marked failed on the next start and can be
  continued.
- **Config changed but behavior did not.** The daemon replaces itself when idle.
  While agents are running it reports `DAEMON_CONFIG_CHANGED`; retry when they finish.
