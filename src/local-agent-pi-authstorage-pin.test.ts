import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { satisfies } from "semver";
import { parse as parseYaml } from "yaml";

// 0.80.8 dropped AuthStorage. pi-coding-agent@0.80.7 still exports it, but
// depends on its sibling packages with ^0.80.7. pnpm 11 ignores that
// package's npm-shrinkwrap and package.json overrides, so those ranges
// install 0.80.10 and AuthStorage fails to load (getOAuthApiKey was
// removed). The direct pin is for npm; pnpm-workspace.yaml overrides keep
// the frozen lockfile on 0.80.7. See Waishnav/devspace#360.
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_SIBLINGS = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-tui",
] as const;
const AUTOSTORAGE_PIN = "0.80.7";
const AUTOSTORAGE_REMOVED_VERSIONS = ["0.80.8", "0.80.9", "0.80.10"] as const;

type PackageManifest = {
  dependencies?: Record<string, string>;
  overrides?: Record<string, string>;
};

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageManifest;

function declaredSpecifier(): string {
  const specifier = packageJson.dependencies?.[PI_PACKAGE];
  if (typeof specifier !== "string") {
    assert.fail(`${PI_PACKAGE} must be a direct dependency`);
  }
  return specifier;
}

test("pi-coding-agent cannot resolve to an AuthStorage-less release", () => {
  const specifier = declaredSpecifier();
  for (const version of AUTOSTORAGE_REMOVED_VERSIONS) {
    assert.equal(
      satisfies(version, specifier),
      false,
      `declared ${PI_PACKAGE}@${specifier} satisfies ${version}, which dropped AuthStorage (issue #360). Pin exact ${AUTOSTORAGE_PIN}.`,
    );
  }
  assert.equal(
    specifier,
    AUTOSTORAGE_PIN,
    `${PI_PACKAGE} must be the exact pin ${AUTOSTORAGE_PIN}, the last release that still exports AuthStorage`,
  );
});

test("pi sibling packages stay on the AuthStorage pin", () => {
  const npmOverrides = packageJson.overrides ?? {};
  const workspace = parseYaml(
    readFileSync(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8"),
  ) as { overrides?: Record<string, string> };
  const pnpmOverrides = workspace.overrides ?? {};
  for (const name of PI_SIBLINGS) {
    assert.equal(
      npmOverrides[name],
      AUTOSTORAGE_PIN,
      `${name} must be overridden in package.json to exact ${AUTOSTORAGE_PIN} so a fresh npm install cannot float onto an AuthStorage-less release`,
    );
    assert.equal(
      pnpmOverrides[name],
      AUTOSTORAGE_PIN,
      `${name} must be overridden in pnpm-workspace.yaml to exact ${AUTOSTORAGE_PIN}; pnpm 11 does not apply package.json overrides`,
    );
  }
});

test("lockfile freezes the AuthStorage pin for the whole pi family", () => {
  const lockText = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
  const match = lockText.match(
    /'@earendil-works\/pi-coding-agent':\r?\n\s+specifier: ([^\r\n]+)\r?\n\s+version: ([^\s(]+)/,
  );
  assert.ok(match, "pnpm-lock.yaml importer must record @earendil-works/pi-coding-agent");
  assert.equal(match[1], declaredSpecifier());
  assert.equal(match[1], AUTOSTORAGE_PIN);
  assert.equal(match[2], AUTOSTORAGE_PIN);

  for (const name of [PI_PACKAGE, ...PI_SIBLINGS]) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const versions = [...lockText.matchAll(new RegExp(`${escaped}@(\\d+\\.\\d+\\.\\d+)`, "g"))].map((found) => found[1]);
    assert.ok(versions.length > 0, `pnpm-lock.yaml must record ${name}`);
    for (const version of versions) {
      assert.equal(
        version,
        AUTOSTORAGE_PIN,
        `${name}@${version} is locked; only ${AUTOSTORAGE_PIN} still matches the AuthStorage session factory`,
      );
    }
  }
});

test("pi session factory still constructs AuthStorage", () => {
  const source = readFileSync(new URL("./local-agent-pi.ts", import.meta.url), "utf8");
  assert.match(source, /AuthStorage,\s*\n\s*ModelRegistry,/);
  assert.match(source, /AuthStorage\.create\(/);
  assert.match(source, /ModelRegistry\.create\(/);
});
