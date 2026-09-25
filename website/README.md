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

## Layout

- `docs/` — documentation content, mounted under `/docs` (`basePath`).
- `islands/` — React islands usable in any MDX page (`<DelegationDiagram />`, `<WorkflowRun />`).
- `ui/` — styles shared by the islands, plus the static `<Logos set="hosts|providers" />` MDX component (registered in `components.ts`).
- `logos/` — brand marks for hosts and providers, the `HOSTS`/`PROVIDERS` lists, and `Logo` components for Astro and React. The SVGs come from the GitCMS marketing site; dark fills were changed to `currentColor` so they follow the theme.
- `pages/` — custom Astro routes. `/` and `/v1`–`/v3` are landing explorations.
- `landing/` — landing page components. `content.ts` holds the copy every variant shares.

## Landing explorations

| Route | Name | Direction |
| --- | --- | --- |
| `/v1` (also `/`) | Workbench | Light, hairline-framed, all-monospace; ChatGPT mockup over a pixel landscape. |
| `/v2` | Field notes | Warm paper, serif display, editorial comparisons, dark local-first band. |
| `/v3` | Night shift | Dark, rotating host headline, autoplaying terminal scenes, gradient-mesh feature rows. |

The floating V1/V2/V3 switcher in `landing/Shell.astro` is for review only;
remove it once a direction is chosen. `/v3?scene=1|2` opens a specific terminal
scene.

Dynamic workflows are documented as a v1.1 preview; they are implemented on the
`codex/workflow-stack-main-reconciliation` branch, not yet on `main`.
