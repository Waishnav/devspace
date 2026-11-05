# devspace.run

The DevSpace website: a [Blume](https://useblume.dev) docs site plus custom
Astro landing pages. It is a standalone npm package, separate from the
`@waishnav/devspace` package at the repository root.

```bash
npm install
npm run dev     # blume dev
npm run build   # static output in dist/
npx blume validate
```

If `blume dev` is already running, `blume build` refuses to run; use
`npx blume build --isolated` (output in `.blume-verify/dist`).

## Deploy

`devspace.run` is the Worker `devspace-site` serving the static build in `dist/`
(`wrangler.jsonc`). It deploys from `main` through Cloudflare Workers Builds:

| Setting | Value |
| --- | --- |
| Root directory | `website` |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |

The `devspace.run` custom domain is declared in `wrangler.jsonc`, so the first
deploy attaches it.

`staging.devspace.run` is a manual deploy that must not be indexed: build, copy
`dist/` to `.staging-dist`, add the noindex `_headers` and `robots.txt`, then
`npx wrangler deploy --env staging`.

## Layout

- `docs/` — documentation content, mounted under `/docs` (`basePath`).
- `islands/` — React islands usable in any MDX page (`<DelegationDiagram />`, `<WorkflowRun />`).
- `ui/` — styles shared by the islands, plus the static `<Logos set="hosts|providers" />` MDX component (registered in `components.ts`).
- `logos/` — brand marks for hosts and providers, the `HOSTS`/`PROVIDERS` lists, and `Logo` components for Astro and React. The SVGs come from the GitCMS marketing site; dark fills were changed to `currentColor` so they follow the theme.
- `pages/` — custom Astro routes (`/` is the landing page).
- `landing/` — landing page components. `content.ts` holds the shared copy.

## Landing page

The landing page is `pages/index.astro` (components in `landing/home/`): light,
hairline-framed, all-monospace, with a tabbed hero (chat app, delegating, any
host to any agent) over a pixel landscape, and a workflow script beside a live
visualizer of its run.

`landing/parked/TerminalScenes.astro` is a tabbed, autoplaying terminal kept from
a retired dark exploration. No page uses it; see the comment at its top for what
it needs.

Dynamic workflows are documented as experimental: in v1.1 they are hidden
behind `DEVSPACE_EXPERIMENTAL_WORKFLOWS=1`.
