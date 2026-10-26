# Subagent conformance replay

`pnpm qa:agents` checks that every subagent driver behaves the same way
through the real path: the built `devspace agents` CLI (`dist/cli.js`), the
daemon, the driver, and a provider process. Only the provider process is
replaced. Each scenario gets a fresh temp config, state directory, and Git
fixture repo, and runs with exactly one provider configured.

```bash
pnpm build
pnpm qa:agents                       # replay every provider that has transcripts
pnpm qa:agents claude pi             # replay chosen providers
pnpm qa:agents pi --scenario stop    # one scenario
pnpm qa:agents claude --live         # real provider binaries, no shim
pnpm qa:agents claude --record       # live, through the record shim; rewrites transcripts
```

Replay needs no provider binaries, logins, or quota. Live and record runs use
the provider's normal login and spend a little quota.

## How it works

The runner points the provider's `command` override (`CLAUDE_COMMAND`,
`PI_COMMAND`, `CODEX_COMMAND`, or the ACP `command`) at a wrapper script that
runs `shim.ts`.

- **Record** spawns the real binary with the same arguments and env, passes
  stdio through unchanged, and tees each newline-delimited frame into
  `transcripts/<provider>/<scenario>.jsonl`. Each entry has a direction (`in` =
  driver to provider) and a time relative to process start.
- **Replay** checks each frame the driver writes against the next recorded
  `in` frame, then emits the provider frames recorded after it. Gaps between
  frames are capped at 25ms. Frames match by kind (method or type) and shape.
  Volatile keys (request, session, and thread ids, timestamps) only need the
  same type, and recorded ids are rewritten to the live ones in replies. A
  mismatch kills the provider process with exit code 70 and prints a
  path-by-path diff in the failing scenario's output.
- Transcripts are scrubbed at record time:
  - the workspace, its dashed per-project form, the temp dir, and `$HOME`
    become placeholders;
  - credential shapes are redacted with `redactSecrets`, and emails are
    replaced;
  - `redactFrame` drops user environment the driver never reads (for Claude:
    hooks, skills, commands, MCP servers, account).

  Review a new transcript before committing it.

`providers.ts` is the only provider-specific file. A `ReplayProtocol` says how
to name a frame's kind, how requests and responses correlate, which keys are
volatile, and which requests are *elastic*. Elastic requests are timing-driven
polls such as Pi's `get_state`. Recorded polls never gate playback, and live
ones are answered with the nearest recorded response.

## Scenarios

These apply to every provider, with the same assertions:

| | Scenario | Passes when |
|---|---|---|
| C1 | `run-wait` | `run` + `wait` completes and the response contains `PAPAYA-7`. |
| C2 | `continue` | `continue` on the same agent recalls the codename from turn one. |
| C3 | `read-only` | A `read_only` agent asked to create `probe.txt` ends `completed` and the file does not exist. The provider may refuse, be denied, or lack a write tool; all of these are the same outcome. It starts the agent with `agents run --write-mode read_only`. |
| C4 | `stop` | `stop` during a `sleep` tool call yields `stopped` within 15s, and two seconds later there are no new events and no `late.txt`. Drivers that do not stream report no `tool_started`, so the stop is sent 8s after `turn_started`. |
| C5 | `events` | One turn id covers `turn_started` … `message` … `turn_completed`. When the driver's `capabilities.turns.streaming` is true, the tool-using prompt also produces `tool_started` and `tool_completed`. |
| C6 | `missing-command` | `agents run` exits non-zero with `PROVIDER_UNAVAILABLE`. No transcript is needed. |

## Adding a stdio provider (Codex, ACP)

1. Add or adjust its entry in `PROVIDERS` in `providers.ts`. `id` is the
   default provider instance id (`codex`, `cursor`, `copilot`, `grok`).
   `realCommand()` is what the driver would run without an override. Codex
   and ACP speak JSON-RPC, so start from the `jsonRpc` protocol. Add
   provider-specific volatile keys and anything the driver polls.
2. Check live first: `pnpm qa:agents <id> --live`. Fix prompts or a real driver
   inconsistency before recording.
3. Record: `pnpm qa:agents <id> --record`. Read the new files for personal data
   and add a `redactFrame` rule if needed.
4. Replay: `pnpm qa:agents <id>`, twice, to confirm it is stable.

A provider that spawns more than one process in a scenario gets
`<scenario>.2.jsonl`, `<scenario>.3.jsonl` and so on, in spawn order. A
`--version` probe (Codex runs one) replays the version recorded in the meta
line.

## HTTP providers (OpenCode)

OpenCode runs `opencode serve` and talks HTTP and SSE, so this stdio shim
cannot sit between it and the driver. The design leaves room for an HTTP
record/replay proxy with the same transcript shape (`in` = request,
`out` = response or SSE event) and the same matching rules. Until that exists,
run OpenCode with `--live` only.

## Re-recording and troubleshooting

- Re-record after a provider CLI or SDK upgrade, after a driver changes the
  frames it sends, or after you change a scenario prompt. A replay failure that
  names a driver frame is expected in those cases.
- `DEVSPACE_AGENT_SHIM_TRACE=1` writes replayed traffic to `replay-trace.log`.
  `DEVSPACE_QA_KEEP=1` keeps each scenario's temp directory, which is always
  kept on failure.
- The daemon socket lives under the state directory. If `TMPDIR` is long,
  daemon startup fails because Unix socket paths are limited to about 100
  characters.
- **Pi:** extensions that override built-in tools (`read`, `bash`, `edit`,
  `write`), such as `pi-foldable-tools`, conflict with DevSpace's sandbox
  extension and Pi exits at startup. To record against a clean Pi, set
  `DEVSPACE_QA_PI_AGENT_DIR` to an agent dir with its own `settings.json`. Use
  `{"packages": [], "defaultProvider": "xai", "defaultModel": "grok-4.3"}` or
  any cheap model. Give it an `auth.json` symlink to `~/.pi/agent/auth.json`;
  Pi writes auth with `writeFileSync`, which follows the link. The runner
  passes the dir as `PI_CODING_AGENT_DIR`.
- **Claude** runs the Agent SDK's bundled CLI, matching DevSpace's default,
  with `model: haiku`.
