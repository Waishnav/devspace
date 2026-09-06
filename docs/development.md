# Development and Manual QA

Use the published DevSpace installation for normal work. When testing DevSpace
itself, run the source checkout against a checkout-local fork of your DevSpace
configuration and SQLite state.

## First run in a checkout

Install dependencies, then seed the checkout from your normal DevSpace setup:

```bash
pnpm install --frozen-lockfile
pnpm dev:seed
pnpm dev
```

`dev:seed` creates an ignored `.devspace-dev/` directory in the current
checkout. It copies the current config, auth file, DevSpace-local skills and
agent profiles, and makes a SQLite backup of the configured state database. The
copied config is rewritten so `storage.stateDir` points at the checkout-local
state directory.

`pnpm dev` only uses that local QA configuration. If the checkout has not been
seeded, it stops with an instruction to run `pnpm dev:seed` instead of silently
falling back to your normal DevSpace state.

By default the seed source is `~/.devspace`. If your normal installation uses a
custom `DEVSPACE_CONFIG_DIR`, keep that value exported while using `dev:seed`
and `dev:reset` so both commands fork the same installation.

## Testing with ChatGPT

Stop the installed DevSpace server before starting the source checkout so both
processes do not compete for the configured port. You can keep the same tunnel
and public URL running.

Because the QA database is forked from your normal state, it starts with the
same registered OAuth clients and current access and refresh tokens. This
usually lets ChatGPT continue through a server restart without setting up a new
connection.

The fork is a snapshot, not shared state. OAuth refresh tokens rotate when they
are used, so a long-lived QA fork can diverge from the normal installation or
from another worktree's older fork. Do not rely on separate QA databases to
remain permanently interchangeable without re-authentication.

## Switching between worktrees

Each worktree keeps its own `.devspace-dev/` state:

```bash
# worktree A
pnpm dev:seed
pnpm dev

# stop it, then switch to worktree B
pnpm dev:seed
pnpm dev
```

Once a worktree has been seeded, later runs only need `pnpm dev`.

This keeps source changes and persistent QA state isolated without requiring
DevSpace to know which Git branch or worktree is active.

## Database and migration changes

Do not point experimental source builds at your normal DevSpace state directory.
Use the checkout-local fork so migrations operate on disposable data that began
as a realistic copy of your current installation.

To repeat a migration from the same baseline, discard the checkout QA state and
fork it again:

```bash
pnpm dev:reset
pnpm dev
```

`dev:reset` replaces the entire `.devspace-dev/` directory from the current
normal DevSpace config and state. Any QA-only workspace sessions, OAuth changes,
agent sessions, and database migrations in that checkout are discarded.

DevSpace also validates the migration journal at startup. If an applied
migration version has a different name than the current build expects, or the
database contains a migration version unknown to the build, startup fails
instead of silently using an incompatible schema.

## Normal verification

The usual repository checks remain:

```bash
pnpm typecheck
pnpm test
pnpm test:e2e
```

The E2E suite builds and installs the package before exercising MCP workflows.
See [Testing DevSpace](testing.md) for coverage, focused runs, and failure logs.
