# Security and Privacy Review

## Public-release boundary

This bundle was produced from a customized DevSpace installation, but only
generic source changes were transferred into the public worktree. The public
branch starts from the upstream v1.0.4 commit and does not include private commit
history from the customized installation.

## Excluded data

The following categories are intentionally excluded:

- personal names, account handles, and local usernames;
- absolute personal project paths;
- private repository names and internal project identifiers;
- Tailscale addresses, tunnel URLs, private hostnames, and callback URLs;
- OAuth owner passwords, access tokens, refresh tokens, cookies, and API keys;
- SSH keys, signing keys, certificates, and cloud credentials;
- local allowed-root lists and approved-command configuration values;
- personal usage logs, shell history, diagnostic history, and screenshots;
- custom product branding that is not part of upstream DevSpace.

Generic references to supported technologies such as Cloudflare Tunnel,
Tailscale, OAuth, GitHub, ChatGPT, or MCP may remain when they are part of normal
product documentation rather than a private endpoint or credential.

## Sanitization checks

The verification script scans changed and untracked text files for known private
markers before running the build. This is a defense-in-depth check, not a proof
that arbitrary unknown secrets cannot exist.

Reviewers should still inspect:

- the complete Git diff;
- newly added JSON and YAML files;
- examples involving paths, commands, hosts, or environment variables;
- generated patch files before publication.

## Local configuration remains local

The approved-shell feature reads a local configuration file at runtime. This
bundle includes the loader and validation logic but does not include any real
approved command entry. Users must create their own configuration outside the
repository.

Usage history is also stored outside the repository by default. No history file
is included in the patch set.

## Safety properties

- Existing workspace root checks remain in force.
- Advertised external instruction reads are restricted to exact discovered
  paths rather than entire directories.
- Optional compound tools remain workspace-scoped and bounded.
- Optional design inspection restricts target hosts through an allowlist.
- The updater checks every patch before applying any patch.
- The updater refuses dirty target trees.
- The updater performs no Git commit, push, publish, deployment, or user-config
  mutation.

## Provenance note

The public preparation workflow was directed through ChatGPT and executed using
DevSpace's own MCP tools. This dogfooding statement describes the workflow only;
it does not imply endorsement by OpenAI or the upstream DevSpace maintainer.
