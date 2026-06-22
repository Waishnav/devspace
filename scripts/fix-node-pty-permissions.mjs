import { chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "darwin") {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  for (const architecture of ["arm64", "x64"]) {
    const helper = resolve(
      projectRoot,
      "node_modules",
      "node-pty",
      "prebuilds",
      `darwin-${architecture}`,
      "spawn-helper",
    );
    try {
      await chmod(helper, 0o755);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
