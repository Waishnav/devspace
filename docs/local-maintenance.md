# Local Maintenance and Performance Notes

This document records verified DevSpace maintenance issues that are easy to
reintroduce when installing another Mac, upgrading the package, rebuilding the
local branch, or starting the service manually.

It is intentionally focused on DevSpace itself. Network-provider incidents,
Cloudflare account operations, and machine-specific credentials belong in the
local operations guide and must not be copied into this file.

## Critical: Do Not Run With Full Widgets

The upstream default is:

```bash
DEVSPACE_WIDGETS=full
```

In `full` mode, DevSpace attaches ChatGPT App widget metadata and card payloads
to workspace, read, write, edit, search, and shell tools. A tool result may then
appear in several forms in the same conversation:

- normal MCP tool content;
- structured tool content;
- widget card payload;
- iframe or widget state retained by the ChatGPT client.

For long coding sessions, especially those with large file reads, diffs, or
shell output, this causes conversation history and front-end state to grow much
faster than the useful working context. The observed symptoms are progressive
latency, heavy rendering, slower tool turns, and eventually an effectively
unusable conversation.

The local deployment therefore runs with:

```bash
DEVSPACE_WIDGETS=changes
```

`changes` mode attaches widget UI only to `open_workspace` and
`show_changes`. Ordinary file, patch, and process calls remain plain MCP
results.

The repository service helper enforces this default:

```bash
widget_mode="${DEVSPACE_WIDGETS:-changes}"
tool_mode="codex"
```

The persisted deployment config also pins the process contract:

```json
{
  "requiredToolMode": "codex"
}
```

When `requiredToolMode` is set, a conflicting `DEVSPACE_TOOL_MODE` or legacy
`DEVSPACE_MINIMAL_TOOLS` value makes the DevSpace process fail before it starts
listening. This is the fail-closed guard against stale copied commands or a
direct tmux respawn that attempts to restore the production endpoint in another
tool mode.

Start the deployed service through the helper:

```bash
./scripts/devspace-service.sh start
```

Do not replace it with a bare production start:

```bash
# Wrong for the maintained ChatGPT deployment: falls back to full widgets.
devspace serve
```

A manual diagnostic start against the production config must preserve the locked mode explicitly:

```bash
DEVSPACE_TOOL_MODE=codex DEVSPACE_WIDGETS=changes devspace serve
```

Do not recover the production service by copying an old `ps`/tmux command or by
issuing `tmux respawn-pane` with a reconstructed server command. The long-lived
tmux server process may retain historical argv from an older deployment mode.
Lifecycle changes to `devspace-service` must go through
`scripts/devspace-service.sh`; diagnostics that genuinely require `minimal` or
`full` must use a separate config directory/session/endpoint instead of changing
the production contract.

### Verify the effective runtime, not only the script

Checking the source file is insufficient because an older tmux session may
still be running with different environment variables. Verify the actual server
pane:

```bash
tmux list-panes -t devspace-service \
  -F '#{window_name}|#{pane_start_command}'
```

The server command must contain:

```text
DEVSPACE_TOOL_MODE=codex
DEVSPACE_WIDGETS=changes
```

The health contract must independently report the same effective mode:

```json
{"ok":true,"name":"devspace","toolMode":"codex","widgets":"changes"}
```

After upgrades or reinstalls, both checks are release-blocking. HTTP 200 alone
is insufficient because an otherwise healthy process may expose the wrong MCP
tool surface.

## Use the Codex Coding Surface

The maintained ChatGPT connection uses `DEVSPACE_TOOL_MODE=codex`. It exposes a
compact but complete coding-agent interface:

```text
open_workspace
read
apply_patch
exec_command
write_stdin
```

`apply_patch` owns the complete file lifecycle, including add, update, delete,
and move. `exec_command` and `write_stdin` own short commands, long-running
processes, stdin, interruption, and PTY interaction. This avoids the incomplete
combination of `write`/`edit` with a deliberately read-only `bash` contract.

The local extensions remain independently registered when enabled:

```text
show_changes
export_file
computer_use
chrome_use
```

`minimal` remains available for isolated diagnostics when using a separate
config/session/endpoint. It must not replace the maintained production endpoint
while `requiredToolMode=codex` is pinned. `full` is not a production fallback;
it adds search schemas without restoring the complete Codex process and patch
model.

Verify the connected App tool list after a deployment or tool-schema change.
Do not assume that rebuilding the server automatically refreshes an existing
ChatGPT App registration.

## Reuse Workspace Sessions

Call `open_workspace` once for a project folder or worktree and reuse the
returned `workspaceId` for later calls in that same workspace.

Repeatedly reopening the same directory creates additional workspace records,
repeats project instructions and Skill catalogs in the conversation, and makes
both client history and server-side session state noisier. Reopen only when:

- switching to another folder or worktree;
- changing checkout/worktree mode;
- the server rejects the previous `workspaceId` as unknown;
- the user explicitly asks to reopen.

## MCP Transport Cleanup

ChatGPT can reconnect and create new MCP transport sessions without always
closing the earlier connection cleanly. Without cleanup, abandoned transports
accumulate in the DevSpace process.

The maintained server includes periodic cleanup:

```text
cleanup interval: 5 minutes
idle timeout: 24 hours
```

The implementation is controlled by:

```text
MCP_SESSION_CLEANUP_INTERVAL_MS
MCP_SESSION_IDLE_TIMEOUT_MS
```

Do not remove this cleanup during rebases or upstream merges. Monitor the
relationship between these log events when diagnosing memory or connection
growth:

```text
mcp_session_created
mcp_session_closed
```

A large and continuously increasing gap is a signal to inspect reconnect
behavior and cleanup rather than repeatedly restarting ChatGPT conversations.

## Use `show_changes` Once

`show_changes` is deliberately available in `changes` mode, but it can still
produce a large aggregate diff. Models should call it once after the final
related file modification, not after every edit.

For very large changes:

- inspect `git diff --stat` and scoped diffs first;
- split unrelated work into separate turns or worktrees;
- avoid repeatedly rendering the same aggregate diff;
- do not use `show_changes` in a non-Git directory merely as a connection test.

A non-Git rejection is expected behavior, not a DevSpace service failure.

## Preserve the Codex-backed local-control architecture

The authoritative target and acceptance plan for local file multimodality,
macOS application control, Chrome control, locked-mode behavior, and the
no-Codex-turn boundary is maintained in
[Local Multimodal Files, Computer Use, and Chrome Use](computer-use.md).

Before changing this area:

1. Reuse the signed Codex Computer Use service and browser runtime; do not add a
   second native desktop or browser automation implementation.
2. Keep DevSpace as a thin authenticated adapter responsible for process
   lifecycle, permission forwarding, result normalization, and MCP content.
3. Verify that no `thread/start` or `turn/start` call is introduced.
4. Discover current ChatGPT/Codex/plugin versions dynamically rather than
   hardcoding installed version directories.
5. Preserve official app, origin, upload, download, and interruption policies.
6. Keep `DEVSPACE_COMPUTER_USE_BACKEND=codex` as the production default. The
   existing Swift helper is an explicit rollback backend only and must never be
   selected automatically.
7. Validate on `local_agent_nick_work` before syncing to the primary
   `local_agent` host.
8. Do not operate the primary host's desktop during deployment without explicit
   user authorization.

Locked-mode results must be reported precisely: the formal Chrome adapter has
passed DOM, screenshot, input, click, and cleanup while the Mac is locked.
Native Computer Use deliberately fails closed because the current ChatGPT MCP
request provides an `openai/session` string but no authentic Codex `turn_id`.
Do not bypass this boundary with fabricated metadata.

Run the local-control acceptance suite after a ChatGPT/Codex update:

```bash
npm test
npm run typecheck
npm run build
DEVSPACE_TEST_CODEX_LIVE=1 npx tsx src/codex-live.test.ts
```

The live suite requires the Chrome extension to be connected. In its current
locked-mode form it verifies Chrome and the native Computer Use failure-closed
boundary. Run an additional unlocked `computer_use` observe/action/re-observe
cycle when a user is available to unlock the validation Mac.

## Refresh ChatGPT App Tool Schemas Safely

ChatGPT freezes an App's tool schema for the lifetime of a conversation. A
service restart updates the MCP server but does not prove that ChatGPT has
rescanned the account-level App definition.

The two-host rollout on 2026-07-30 established the preferred recovery path:

- both Apps initially showed the stale six-action schema;
- the user performed **account-level Refresh only**;
- no Uninstall, reinstall, Reconnect, OAuth repetition, or network change was
  performed;
- both Apps then exposed the expected eight actions, including `computer_use`
  and `chrome_use`.

Use this procedure after adding or removing MCP tools:

1. Check **Tools for this app** and record the exact action count and names.
2. Treat the server-side tool-list test as necessary but not sufficient; it does
   not prove what ChatGPT has stored for the account-level App.
3. Run the App's account-level **Refresh** once, then inspect the action list
   again. Do not begin with uninstall/reinstall.
4. Open a fresh **Chat** conversation only when the existing conversation still
   holds an older frozen schema.
5. Use an account-authenticated ChatGPT instance for Personal Apps. An API-key
   identity can run local Codex workflows but cannot list the remote Personal
   App catalog.
6. Use Reconnect or OAuth only for an actual authentication failure. A transient
   502 during a service restart is not evidence that authorization is lost;
   wait for health recovery and retry the connector first.
7. Uninstall/reinstall is a last resort only after evidence shows that
   account-level Refresh did not rescan the target App. It is not a routine
   schema-update step.
8. Confirm the final action count before functional acceptance. Do not infer
   success merely from the App appearing as Connected.
9. Do not change system proxies, PAC, VPN/Tailscale, Clash, or unrelated network
   settings to refresh an App schema.

## Application approval when the MCP host lacks elicitation UI

The signed Computer Use client requires an application-scoped approval before
first observing or controlling an app. Some ChatGPT MCP paths do not render the
nested `elicitation/create` request and previously reduced that condition to a
generic `Internal error`.

DevSpace now fails closed and returns `approvalRequired`, the official approval
message, and its schema. The caller may retry with `appApproval=accept` only
after the user has explicitly authorized that bounded low-risk action. DevSpace
must never infer or persist acceptance merely because the outer tool call was
allowed. `decline` and `cancel` remain explicit outcomes.

DevSpace keeps one authorized MCP client per instance. Reauthorizing a replacement
client invalidates the earlier client's access and refresh tokens, as documented
in [Security Model](security.md).

## Two-host regression policy

`local_agent_nick_work` is the canonical functional validation host. For normal
implementation and documentation changes, run the complete native image,
Chrome, application approval, and Computer Use path there. The primary
`local_agent` host is validated by synchronized SHA-256 hashes, the expected
eight-action App schema, tests/build, effective service command, and local/public
health.

Repeat native desktop actions independently on both hosts only when the change
may depend on machine state: macOS or ChatGPT/Codex versions, code signatures,
Accessibility or Screen Recording permissions, displays, input devices, the
Chrome extension, or another host-specific runtime difference. This avoids
duplicating an identical low-risk desktop test while preserving coverage for
real machine-specific risks.

The current two-host rollout state and exact recovery sequence are maintained in
[DevSpace final acceptance handoff](devspace-final-acceptance-handoff.md).

## Upgrade and Restart Checklist

After changing DevSpace code, installing a new package version, or moving the
installation to another Mac:

1. Install dependencies and run tests/build.
2. Confirm `scripts/devspace-service.sh` pins `tool_mode="codex"` and the
   production `~/.devspace/config.json` pins `requiredToolMode=codex`.
3. Confirm MCP idle-session cleanup still exists and its tests pass.
4. Install the intended local build globally.
5. Stop and restart through `scripts/devspace-service.sh`; do not reconstruct or
   respawn the production server command by hand.
6. Inspect the actual tmux server command and `/healthz` contract for
   `toolMode=codex`, `DEVSPACE_WIDGETS=changes`, `DEVSPACE_COMPUTER_USE=1`, and
   `DEVSPACE_COMPUTER_USE_BACKEND=codex`.
7. Negative-test the lock: a direct start with `DEVSPACE_TOOL_MODE=minimal`
   against the production config must fail before listening.
8. Confirm a fresh ChatGPT connector session exposes `apply_patch`,
   `exec_command`, `write_stdin`, `show_changes`, `export_file`, `computer_use`,
   and `chrome_use`; it must not expose `write`, `edit`, `bash`,
   `capture_screen`, or `computer_action`.
9. Run full functional acceptance on `local_agent_nick_work`; on the primary host
   verify synchronized hashes, tool schema, build, effective runtime command, and
   health unless a machine-specific risk requires independent desktop actions.
10. Open one workspace and reuse its `workspaceId` during acceptance.
11. Run real add/update/delete/move and short/long process turns, then call
    `show_changes` once for the related file change set.
12. Check server logs for unexpected session growth, orphaned process sessions,
    and sustained tool errors.

Do not declare an upgrade complete based only on `devspace doctor` or a single
`/healthz` response. Those checks do not validate the effective widget mode,
tool schema seen by ChatGPT, or conversation-growth behavior.

## Known Safe Runtime Shape

The maintained local deployment should have the following characteristics:

```text
DEVSPACE_TOOL_MODE=codex
DEVSPACE_WIDGETS=changes
DEVSPACE_COMPUTER_USE=1
DEVSPACE_COMPUTER_USE_BACKEND=codex
DEVSPACE_CLOUDFLARED_PROTOCOL=http2
MCP idle-session cleanup enabled
one reused workspaceId per active project/worktree
show_changes called once per related change set
```

Any deviation should be intentional, documented, and tested in a fresh
ChatGPT conversation before replacing the established runtime.
