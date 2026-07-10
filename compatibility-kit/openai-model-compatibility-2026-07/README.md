# DevSpace OpenAI Model Compatibility Kit

This directory packages a reviewable compatibility update for DevSpace v1.0.4.
It was prepared after a recent ChatGPT model rollout changed the practical
behavior of multi-step MCP tool execution. The observed regression affected both
GPT-5.5 and GPT-5.6: operations that had previously completed normally became
slow, stalled, or unreliable.

This is intentionally described as a compatibility update rather than a
GPT-5.6-only patch. No assumption is made about undocumented OpenAI internals.

## What this kit changes

- Reduces the initial `open_workspace` payload through bounded instruction
  excerpts and lazy full-file reads.
- Keeps advertised instruction files readable without widening the workspace
  filesystem allowlist.
- Adds execution-cost diagnostics for response volume, duration, Tool calls,
  errors, and retries while keeping token values explicitly approximate.
- Adds opt-in compound inspection tools for common, bounded read-only workflows.
- Adds safer support for explicitly pre-approved shell command aliases.
- Improves built-in agent profile, skill matching, design-audit, and MCP App
  integration paths while keeping the features opt-in.
- Adds safe standard PATH discovery without sourcing login-shell configuration.
- Integrates runtime diagnosis, compatibility smoke checks, cost snapshots, and
  workspace-scoped Finder actions into the existing Tool surface.
- Includes tests for the compatibility behavior and feature flags.

## Scope and privacy

The bundle contains only generic DevSpace changes. It does not contain:

- personal filesystem paths or usernames;
- private repositories or private integration endpoints;
- credentials, access tokens, cookies, owner passwords, or private keys;
- machine-specific allowlists or approved command configurations;
- custom product names or private branding;
- personal logs, usage history, or screenshots.

See `docs/SECURITY_AND_PRIVACY.md` for the sanitization rules.

## Requirements

- A clean checkout of `Waishnav/devspace` at release `v1.0.4` or commit
  `d03187460cebdc2820e797cb59740537100a0f99`.
- Node.js compatible with the repository's `engines` field.
- Git available on `PATH`.

## Apply

From the root of a clean DevSpace v1.0.4 checkout:

    node compatibility-kit/openai-model-compatibility-2026-07/apply.mjs

The script performs all `git apply --check` operations before changing files. It
refuses to run against a dirty working tree or an unsupported package/version.

Then validate:

    node compatibility-kit/openai-model-compatibility-2026-07/verify.mjs

The verification script runs dependency installation, type checking, tests, and
the production build. Review the diff before committing.

## Roll back

Before applying, create a branch or commit in the target checkout. If the patch
has not been committed, restore the checkout with Git after reviewing the
changes. The apply script does not commit, push, publish, deploy, or modify user
configuration.

## Maintainer review

The patch set is split by responsibility:

1. `0001-compact-workspace-and-usage.patch`
2. `0002-safe-tools-and-compound-inspection.patch`
3. `0003-agents-skills-app-integration.patch`
4. `0004-runtime-diagnostics-and-costs.patch`
5. `0005-existing-tool-runtime-integration.patch`
6. `0006-finder-app-action.patch`

The same changes are also present directly in the pull-request branch, so the
maintainer can review normal source diffs without running the updater.

## Dogfooding note

The investigation, sanitization, compatibility-kit preparation, validation, and
GitHub delivery workflow were executed from ChatGPT instructions using DevSpace
itself. This demonstrates the exact MCP workflow being improved; it is not a
security guarantee or a substitute for maintainer review.

## Status

This is a community compatibility proposal, not an official DevSpace release.
Feature flags remain opt-in where practical, and upstream maintainers retain
full control over naming, versioning, scope, and release decisions.
