# Development

How to build, QA, and release DevSpace from a source checkout. For contribution policy, see [CONTRIBUTING.md](CONTRIBUTING.md).

Use the published DevSpace installation for normal work. Develop against a
checkout-local fork of your configuration and state.

## Prerequisites

Use Node `>=22.19 <27`, npm, Git, and Bash (Git Bash or WSL on Windows).
Install the pnpm version pinned in `package.json`:

```bash
npm install --global pnpm@11.25.0
```

Real-host QA with ChatGPT also needs a public HTTPS URL forwarding to the local
server. You own the tunnel or reverse proxy.

## Set up local QA

Start with an initialized DevSpace installation, then run from the checkout:

```bash
pnpm install --frozen-lockfile
pnpm dev:seed
pnpm dev
```

`dev:seed` creates the ignored `.devspace-dev/` directory. It copies the config,
auth file, DevSpace-local skills and agent profiles, makes a SQLite backup of
the configured state database, and rewrites `storage.stateDir` to checkout-local
state. The seed source defaults to `~/.devspace`. If your installation uses a
custom `DEVSPACE_CONFIG_DIR`, keep it exported for both `dev:seed` and
`dev:reset` so they fork the same installation.

`pnpm dev` requires seeded QA configuration and fails with setup instructions
when it is missing. It never falls back to your normal state.

## Test with a real host

Stop the installed DevSpace server before running the source server on the same
configured port. The tunnel and public URL can stay running.

The forked database includes registered OAuth clients and current access and
refresh tokens, so the host usually keeps its connection through the restart.
Refresh tokens rotate when used, though. QA state is a snapshot: it can diverge
from your normal installation or another worktree's snapshot and require
re-authentication.

Each worktree owns its `.devspace-dev/`. Seed once per worktree; subsequent runs
only need `pnpm dev`. Stop the current server before switching worktrees.

## Repeat migration QA or reset state

Never point experimental builds at your normal state directory. To repeat a
migration from a fresh snapshot of your installation:

```bash
pnpm dev:reset
pnpm dev
```

`dev:reset` replaces the entire QA directory. It discards QA-only workspaces,
OAuth changes, agent sessions, and applied migrations, then seeds from the
current normal config and state.

Startup rejects an applied migration version whose name differs from what the
build expects, or a migration version unknown to the build. Renumber migrations;
never reuse migration versions.

## Run verification

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Replay provider conformance

Build first, then run the suite:

```bash
pnpm build
pnpm qa:agents
pnpm qa:agents pi --scenario stop
pnpm qa:agents claude --live
pnpm qa:agents <provider> --record
```

The seven scenarios are `run-wait`, `continue`, `read-only` (a write attempt),
`stop`, `events`, `missing-command`, and `worktree`. They exercise the built CLI
→ daemon → real driver with isolated config, state, and a Git fixture. Default
replay replaces the provider process with a transcript shim and needs no
provider binaries, login, or quota. It cannot prove real provider tool execution;
for example, live and record runs also verify the worktree's file write.

`--live` uses real providers and their normal login and quota. `--record` runs
live through a recorder and rewrites that provider's transcripts. Re-record
after provider CLI, SDK, protocol, or scenario-prompt changes, and inspect new
transcripts for personal data before committing them.

Providers are registered in `test/agents-replay/providers.ts`. See
[test/agents-replay/README.md](test/agents-replay/README.md) for adding providers,
transcript format, scrubbing, and troubleshooting.

## Replay MCP calls and widgets

```bash
pnpm qa --list
pnpm qa
pnpm qa codex-edit-review
pnpm qa --serve --no-browser codex-edit-review
```

`pnpm qa` runs scripted MCP calls against an isolated server and renders cards
in a local MCP Apps host. It uses `agent-browser` to capture screenshots and
page errors, so install that command for browser QA. No seeded state or real
host is needed. Read the generated report and inspect screenshots before
claiming that the UI works; use a real host for host-specific behavior.

See [.agents/skills/replay-qa/SKILL.md](.agents/skills/replay-qa/SKILL.md) for
scenarios, interactive `--serve` mode, and attaching PR evidence. Stop the serve
process when finished.

## Build the website

`website/` is a standalone npm package. From the repository root:

```bash
cd website
npm ci && npm run build
npx blume validate
```

See [website/README.md](website/README.md). If `blume dev` is already running,
the normal build refuses to run; use `npx blume build --isolated` for output in
`.blume-verify/dist`.

## Publish a release

Use the manual **Release** GitHub Actions workflow, dispatched from `main` at a
commit with a successful `CI` push run. Enter the version without a leading `v`.
Do not publish normal releases directly from a development checkout.

```text
1.1.0-beta.1 -> @beta
1.1.0-rc.1   -> @beta
1.1.0        -> @latest
```

The workflow accepts `X.Y.Z`, `X.Y.Z-beta.N`, or `X.Y.Z-rc.N`, with positive
prerelease numbers. It temporarily sets the package version, runs the package
install smoke test, and packs the release artifact. Prerelease versions are not
committed. Stable versions below the source version or npm's current `latest`
are rejected.

The tarball is attached to a draft GitHub release before npm publication. The
GitHub release becomes public only after npm succeeds. After a stable release,
the workflow records the version on `main` as `chore(release): prepare vX.Y.Z`
unless it is already recorded. If `main` moved and still needs a version sync,
the workflow fails rather than overwriting concurrent work.

### Configure npm trusted publishing

The workflow publishes `@waishnav/devspace` using GitHub Actions OIDC, with
`id-token: write` and npm 11.8.0. Configure its npm trusted publisher with:

- Owner: `Waishnav`
- Repository: `devspace`
- Workflow: `release.yml`
- No GitHub environment
- Allow direct `npm publish`

Re-running a version must identify the same source commit, artifact, and release
channel. An existing npm version must match the newly packed tarball's integrity
and already be assigned to the requested dist-tag. Draft releases can resume.
Public releases are never rewritten: the workflow verifies their target commit,
prerelease state, npm state, and attached tarball, and succeeds only when they
match. Partial or mismatched public releases fail for manual investigation.
