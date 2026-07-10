# Changelog

## 2026.07.2

- Added safe standard PATH augmentation without sourcing login-shell files.
- Added bounded runtime diagnosis and compatibility smoke checks through the
  existing Bash Tool instead of expanding the model-facing Tool catalog.
- Expanded usage estimates into execution-cost summaries with observed duration,
  calls, errors, retries, and character volume.
- Added workspace-scoped Finder integration as an app-only Tool and result-card
  action, with root-guard validation.
- Added dedicated runtime tests and three ordered compatibility patches.

## 2026.07.1

- Added compact `open_workspace` payload behavior with bounded instruction
  excerpts and explicit full reads.
- Added exact-path access for advertised instruction files outside the project
  root without widening directory access.
- Added optional text-volume diagnostics.
- Added optional compound inspection tools and safe inspection helpers.
- Added explicitly configured approved-shell aliases with workspace validation.
- Added optional built-in agent profiles, skill matching, design-audit tooling,
  and generic skill templates.
- Added tests, feature flags, configuration documentation, and updater scripts.
- Removed private branding, personal paths, private endpoints, configuration
  values, and local diagnostic artifacts from the public proposal.
- Documented that the compatibility workflow was prepared through ChatGPT
  instructions using DevSpace itself.
