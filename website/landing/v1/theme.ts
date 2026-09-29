import type { ShikiConfig } from "astro";

// Code theme drawn from the V1 palette: warm neutrals for structure, amber for
// literals (the same amber as running states), and green only for DevSpace's own
// primitives (agent, parallel, phase) so they stand out from plain JavaScript.
type Theme = NonNullable<ShikiConfig["theme"]>;

export const workbenchTheme = {
  name: "devspace-workbench",
  type: "dark",
  colors: { "editor.background": "#151515", "editor.foreground": "#e7e5df" },
  tokenColors: [
    { scope: ["comment"], settings: { foreground: "#6d6c67", fontStyle: "italic" } },
    { scope: ["keyword", "storage", "storage.type", "keyword.control"], settings: { foreground: "#8f8d86" } },
    { scope: ["keyword.operator", "punctuation", "meta.brace", "meta.delimiter"], settings: { foreground: "#6d6c67" } },
    { scope: ["string", "string.template", "punctuation.definition.string"], settings: { foreground: "#e6b06e" } },
    { scope: ["constant.numeric", "constant.language"], settings: { foreground: "#e6b06e" } },
    { scope: ["entity.name.function", "support.function", "meta.function-call"], settings: { foreground: "#7ee2a8" } },
    { scope: ["variable.other.property", "meta.object-literal.key", "support.type.property-name"], settings: { foreground: "#bdbab2" } },
    { scope: ["variable", "variable.other.readwrite", "meta.definition.variable"], settings: { foreground: "#e7e5df" } },
    { scope: ["punctuation.definition.template-expression"], settings: { foreground: "#8f8d86" } },
  ],
} as unknown as Theme;

// Light counterpart for code shown on paper-coloured cards (profile files).
export const workbenchLightTheme = {
  name: "devspace-workbench-light",
  type: "light",
  colors: { "editor.background": "#f7f7f5", "editor.foreground": "#151515" },
  tokenColors: [
    { scope: ["entity.other.document.begin.yaml", "entity.other.document.end.yaml", "punctuation", "comment"], settings: { foreground: "#a3a19a" } },
    { scope: ["entity.name.tag.yaml", "support.type.property-name"], settings: { foreground: "#6d6c67" } },
    { scope: ["string", "string.unquoted", "constant.numeric", "constant.language"], settings: { foreground: "#9a5b13" } },
  ],
} as unknown as Theme;
