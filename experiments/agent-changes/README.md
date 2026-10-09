# DevSpace Agent Changes (experimental)

An isolated hackathon prototype for comparing independent coding-agent proposals, stored in Cloudflare Artifacts. This is not part of the production DevSpace MCP service.

## Prerequisites

- Cloudflare account with Artifacts, Workers Paid, Workers AI, Dynamic Workers, and Containers access (later stages)
- Wrangler authentication (`pnpm wrangler login`)
- Artifacts namespace `devspace-agent-changes` created in your account

Run `pnpm install`, then set a secret with `pnpm wrangler secret put DEMO_TOKEN` before deployment. Never commit this token. Invoke protected API endpoints with `Authorization: Bearer <DEMO_TOKEN>`.

The project importer accepts only public `github.com/<owner>/<repo>` URLs in V0. Imported repositories and later forks are created in the `devspace-agent-changes` Artifacts namespace; they incur resource usage. No deployment has been performed by adding this directory.
