// Re-render every social card after `blume build` with the DevSpace layout:
// the full-size mark beside a wordmark, and a GitHub footer. Blume still
// generates the cards and their og:image tags; its card has no template hook,
// so this overwrites each PNG in place using the same renderer (Takumi).
//
// Usage: node scripts/og-cards.mjs [distDir]   (default: dist)
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { render } from "takumi-js";
import { container, image, text } from "takumi-js/helpers";

const SITE = "https://devspace.run";
const REPO = "Waishnav/devspace";
const WIDTH = 1200;
const HEIGHT = 630;
const COLORS = { background: "#f5f5f3", foreground: "#151515", muted: "#6d6c67", border: "#dcdcd7" };

const root = new URL("..", import.meta.url).pathname;
const dist = join(root, process.argv[2] ?? "dist");
const font = (path) => readFile(join(root, "node_modules", path));

// The landing page's own faces, read from disk so the build needs no network.
const fonts = [
  { name: "IBM Plex Mono", weight: 600, data: await font("@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2") },
  { name: "IBM Plex Mono", weight: 500, data: await font("@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2") },
  { name: "Hanken Grotesk", data: await font("@fontsource-variable/hanken-grotesk/files/hanken-grotesk-latin-wght-normal.woff2") },
];

const mark = `data:image/png;base64,${(await readFile(join(root, "public/logos/devspace-blue.png"))).toString("base64")}`;

const github = `data:image/svg+xml;base64,${Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="${COLORS.muted}" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`,
).toString("base64")}`;

const card = ({ title, description }) =>
  container({
    style: {
      width: WIDTH, height: HEIGHT, padding: 72, display: "flex", flexDirection: "column",
      justifyContent: "space-between", backgroundColor: COLORS.background, color: COLORS.foreground,
    },
    children: [
      container({
        style: { display: "flex", alignItems: "center", gap: 18 },
        children: [
          image({ src: mark, width: 61, height: 64 }),
          text("DevSpace", { fontFamily: "IBM Plex Mono", fontWeight: 600, fontSize: 44, letterSpacing: "-0.02em" }),
        ],
      }),
      container({
        style: { display: "flex", flexDirection: "column" },
        children: [
          text(title, {
            fontFamily: "IBM Plex Mono", fontWeight: 600, fontSize: title.length > 32 ? 56 : 68,
            letterSpacing: "-0.035em", lineHeight: 1.1, maxWidth: 1040, textWrap: "balance",
          }),
          description
            ? text(description, {
                fontFamily: "Hanken Grotesk", fontSize: 30, lineHeight: 1.4, color: COLORS.muted,
                marginTop: 24, maxWidth: 960, textWrap: "balance",
              })
            : container({}),
        ],
      }),
      container({
        style: {
          display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 28,
          borderTop: `1px solid ${COLORS.border}`, fontFamily: "IBM Plex Mono", fontWeight: 500, fontSize: 24, color: COLORS.muted,
        },
        children: [
          container({
            style: { display: "flex", alignItems: "center", gap: 12 },
            children: [image({ src: github, width: 28, height: 28 }), text(REPO)],
          }),
          text("devspace.run"),
        ],
      }),
    ],
  });

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'" };
const decode = (value) => value.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, name) => ENTITIES[name]);

const meta = (html, property) =>
  decode(html.match(new RegExp(`<meta property="${property}" content="([^"]*)"`))?.[1] ?? "");

// Drop the site name Blume appends to page titles, and the landing's brand prefix.
const headline = (title) => {
  const bare = title.replace(/ - DevSpace$/, "").replace(/^DevSpace — /, "");

  return bare.charAt(0).toUpperCase() + bare.slice(1);
};

async function* htmlFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) yield* htmlFiles(path);
    else if (entry.name.endsWith(".html")) yield path;
  }
}

let count = 0;

for await (const file of htmlFiles(dist)) {
  const html = await readFile(file, "utf8");
  const imageUrl = meta(html, "og:image");

  // Only cards this site generated; a page-specific seo.image is left alone.
  if (!imageUrl.startsWith(`${SITE}/og/`)) continue;

  const png = await render(card({ title: headline(meta(html, "og:title")), description: meta(html, "og:description") }), {
    width: WIDTH, height: HEIGHT, format: "png", fonts,
  });

  await writeFile(join(dist, imageUrl.slice(SITE.length)), png);
  count++;
}

console.log(`og-cards: rendered ${count} DevSpace cards into ${dist}/og`);
