# Architecture and Integration Notes

## Problem statement

After a recent ChatGPT model rollout, multi-step DevSpace sessions became
materially slower or less reliable with both GPT-5.5 and GPT-5.6. The practical
failure mode was not limited to one model name: large initial tool payloads and
verbose repeated tool results increased the amount of context exchanged before
useful work could begin.

This proposal does not depend on undocumented model internals. It reduces the
amount of information sent eagerly, makes follow-up reads explicit, and adds
bounded higher-level operations for common workflows.

## Workspace lifecycle

The MCP client calls `open_workspace` once for a checkout or managed worktree.
The returned `workspaceId` is then reused for file reads, searches, edits,
writes, and shell execution.

The compatibility behavior changes the initial response as follows:

- Instruction files are represented by bounded excerpts in compact mode.
- Full instruction content remains available through the existing `read` tool.
- Nested instruction paths are advertised without eagerly sending every file.
- Skill descriptions and diagnostics are omitted from the initial compact
  payload when they are not needed.
- Payload and instruction-character metrics are returned for diagnosis.

This preserves the instruction-following contract while reducing initial MCP
response size.

## Safe instruction reads

An instruction file may live outside the selected project root, for example in
a user-level agent configuration directory. The workspace registry records only
instruction paths that were explicitly discovered and advertised during
workspace opening. A later `read` can access those exact files, but this does not
create a general read permission for their parent directories.

## Tool result metrics

The usage meter estimates text volume from characters handled by DevSpace. It is
not OpenAI usage, token billing, or a model-provider measurement. Its purpose is
to compare payload sizes and identify unnecessary context expansion.

The reporting mode is configurable:

- `off`: do not append estimates to tool results;
- `compact`: append a one-line estimate;
- `full`: append per-tool and estimated-savings details.

History writes are diagnostic-only and cannot fail the underlying tool call.

## Compound tools

Optional compound tools combine bounded, commonly repeated read-only steps.
They reduce round trips without introducing an autonomous execution loop. Each
compound tool retains explicit input schemas, workspace scoping, output limits,
and the same path-resolution rules as the primitive tools.

The primitive file and shell tools remain available. Compound tools are disabled
unless explicitly enabled.

## Approved shell aliases

The approved-command mechanism does not accept an arbitrary command definition
from the MCP client. The client supplies only an alias. DevSpace resolves that
alias from a local configuration file and verifies:

- the alias syntax;
- that the entry is enabled;
- that its configured workspace root exactly matches the active workspace;
- that the configured working directory remains within the allowed root;
- that the locally configured command is non-empty.

The local approved-command file is not included in this compatibility bundle.

## Agents, skills, and Apps

The proposal adds generic built-in agent profiles and skills as optional
capabilities. It also keeps MCP App metadata and structured tool content aligned
with compact-mode results. These components are generic templates and contain
no private integration destinations or user-specific configuration.

Feature flags allow maintainers and users to adopt the capabilities separately:

- `DEVSPACE_SKILL_MATCHER`
- `DEVSPACE_COMPOUND_TOOLS`
- `DEVSPACE_BUILTIN_PROFILES`
- `DEVSPACE_DESIGN_AUDIT`

## Compatibility posture

The branch keeps the upstream package version unchanged. Version selection and
release publication belong to the upstream maintainer. The compatibility kit
applies source changes only and never commits, pushes, publishes, deploys, or
changes user configuration.
