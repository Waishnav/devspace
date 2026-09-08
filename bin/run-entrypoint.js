import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function runEntrypoint(sourcePath, distPath) {
  const sourceUrl = new URL(sourcePath, import.meta.url);
  if (existsSync(fileURLToPath(sourceUrl))) {
    try {
      await import("tsx/esm");
    } catch (error) {
      throw new Error(
        "DevSpace source checkout detected, but tsx is unavailable. Run `pnpm install` in the checkout; refusing to fall back to potentially stale dist output.",
        { cause: error },
      );
    }
    await import(sourceUrl.href);
    return;
  }

  await import(new URL(distPath, import.meta.url).href);
}
