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
pnpm build
```

## Releases

Releases are published by the manual `Release` GitHub Actions workflow. Do not
publish the package directly from a development checkout for normal releases.
The workflow only accepts runs dispatched from `main`, and the exact commit must
already have a successful `CI` push run.

Prereleases use the `beta` npm dist-tag. Both beta and release-candidate
versions follow the same install channel:

```text
1.1.0-beta.1 -> @beta
1.1.0-beta.2 -> @beta
1.1.0-rc.1   -> @beta
1.1.0        -> @latest
```

Run the workflow from GitHub Actions and enter the version without a leading
`v`, for example `1.1.0-beta.1`. The workflow temporarily writes prerelease
versions into `package.json`, validates and packs that exact source commit,
publishes the resulting tarball to npm, and then publishes the matching GitHub
release. Prerelease version changes are not committed back to `main`.

Stable releases use the same temporary version change while building and
publishing. After npm and GitHub publication both succeed, the workflow commits
the released version back to `main` as `chore(release): prepare vX.Y.Z`. If
`main` moved while the release was running, the version sync fails instead of
overwriting concurrent work. This keeps the source tree aligned with the latest
stable release without creating version commits for every beta or release
candidate. A stable release is rejected if its version is lower than either the
source version or npm's current `latest` version.

### npm trusted publishing setup

The release workflow authenticates to npm through GitHub Actions OIDC instead of
a long-lived npm token. Configure `@waishnav/devspace` on npm with a GitHub
Actions trusted publisher using:

- repository owner: `Waishnav`
- repository: `devspace`
- workflow filename: `release.yml`
- no GitHub environment
- allow direct `npm publish`

The workflow uses a GitHub-hosted runner, requests `id-token: write`, and pins an
npm CLI new enough for trusted publishing. Its package artifact is also attached
to a draft GitHub release before npm publication; the GitHub release is made
public only after npm succeeds.

Re-running the same version is safe only when it still identifies the same
artifact and release channel. Existing npm versions must have the same package
integrity as the newly packed tarball and already be assigned to the requested
`beta` or `latest` dist-tag. Existing draft GitHub releases may be resumed, but
public releases are never modified: the workflow verifies npm state and the
published GitHub tarball and exits successfully only when they already match.
Any partial or mismatched public release fails for manual investigation instead
of rewriting published state.
