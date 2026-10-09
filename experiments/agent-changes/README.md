# DevSpace Agent Changes

An experimental agent-native Git review app for the Cloudflare Artifacts hackathon. Two coding agents work in independent forks and Computer-backed Durable Object filesystems; a human compares their diffs and chooses one to cherry-pick into the baseline.

This is a **standalone prototype**, not a remote backend for the production DevSpace MCP server. The Cloudflare Computer and Artifacts APIs are experimental.

## Setup

Requires a Cloudflare account with access to **Artifacts**, **Workers AI**, **Dynamic Workers**, and **Containers**. The Artifacts namespace `devspace-agent-changes` must exist in the account. Configure another namespace in `wrangler.jsonc` if necessary. A namespace binding does not create a namespace automatically.

From the repository root:

```bash
cd experiments/agent-changes
pnpm install --ignore-workspace
pnpm typecheck
pnpm test
pnpm build
pnpm wrangler login
pnpm wrangler artifacts namespaces list
pnpm wrangler secret put DEMO_TOKEN
pnpm deploy
```

Generate a long random `DEMO_TOKEN` and enter it using Wrangler's secret prompt. **Never place it in source, `.env`, a URL parameter, or commit history.** The browser prompts for the token and retains it in `sessionStorage` for the current tab session. A demo token gates all `/api/*` endpoints; this is intentionally not multi-user authentication.

If `wrangler artifacts namespaces list` reports **10004 Access denied**, first resolve Artifacts availability/permission on the account. No subsequent steps can validate real repository operations until this works.

## Walkthrough

1. Visit the deployed Worker and enter the demo token.
2. Import a **small, public GitHub repository** (HTTPS URL).
3. Supply two separate task briefs and click **Launch both agents**.
4. DevSpace forks the imported Artifacts repository twice and starts distinct Durable Objects. Each one clones its own fork into a persistent Computer workspace. The agents call Cloudflare Workers AI, use the Computer file tools, and can run native tests through the Linux backend.
5. Agent edits are committed and pushed to their own forks. The frontend polls for completion.
6. Select each proposal to inspect the diff. Overlapping-file warnings are informational, not evidence of an actual merge conflict.
7. Click **Accept proposal** to cherry-pick the chosen commit into a fresh base checkout. The operation verifies the baseline commit before pushing. Conflicts are reported without pushing to the base.

The base repository is **inside Artifacts**, not the original GitHub repository. This experiment never pushes to GitHub. Agents run against untrusted code: use a disposable public test project and keep the Cloudflare account's quotas in mind.

## API

All `/api/*` routes require `Authorization: Bearer <DEMO_TOKEN>`.

| Route | Purpose |
| --- | --- |
| `POST /api/projects` | `{ "sourceUrl": "https://github.com/owner/repo" }` |
| `GET /api/projects/:id` | Project metadata |
| `POST /api/projects/:id/compare` | `{ "prompts": ["task A", "task B"] }` |
| `GET /api/projects/:id/tasks` | Run statuses and published commit IDs |
| `GET /api/projects/:id/proposals` | Diff previews and overlapping-file warnings |
| `POST /api/projects/:id/accept` | `{ "taskId": "..." }`, merges one completed proposal |
| `GET /health` | Unauthenticated health response |

Project IDs are durable and are kept in the browser URL (`?project=<id>`). All runnable task contexts are assigned their own DO storage. Only **two agents and one comparison per project** are supported in v0. Diff previews are capped at 32 KB; agent turns are capped at eight, and the Worker does not expose Git tokens in API responses.

## Intentional limits

- No GitHub OAuth, private-repository import, external GitHub publishing, or end-user accounts.
- No persisted full agent transcript or live tool-call log in the UI. Agent summaries and committed Git changes are exposed.
- Automated test outcomes are **not recorded** as a verified separate artifact. The UI says so rather than claiming tests passed.
- No AI conflict resolution. Accepting an outdated proposal returns an error; genuine cherry-pick conflicts remain local to the integration directory.
- Compute retry/restart recovery, timeouts, quota enforcement, cleanup of stale forks, and private execution isolation need substantial hardening before any production use.
- Cloudflare resource usage and Workers AI inference are billable. Do not expose this demo token publicly or use it with repositories containing secrets.

The Workers AI transport adapter in `src/workers-ai.ts` is adapted from the MIT-licensed [`cloudflare/computer` pi-ai example](https://github.com/cloudflare/computer/tree/main/examples/pi-ai); the `Dockerfile` is based on its MIT-licensed Think/Linux example.
