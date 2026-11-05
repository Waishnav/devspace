# GitCMS configuration

GitCMS (https://gitcms.dev) reads this folder to edit the site's content. Prefer changing it in the GitCMS app; when you edit these files directly:

- A collection exists because `sites/<site_key>/collections/<name>.jsonc` exists, and site data because `sites/<site_key>/singletons/<name>.jsonc` exists. To add, rename, or remove one, add, rename, or delete its file.
- Names are lowercase letters, numbers, `-`, and `_`. The file name is the name; don't put a `name` inside the file.
- `collections` and `singletons` in `config.jsonc` only set the order in the sidebar. Items they don't list come after, alphabetically.
- Don't change `version` by hand. To upgrade, run `npx create-gitcms migrate --write`.
- After editing, run `npx create-gitcms check` and fix anything it reports.
