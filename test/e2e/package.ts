import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const exec = promisify(execFile);
export const repository = fileURLToPath(new URL("../../", import.meta.url));

export async function installPackage() {
  const root = await mkdtemp(join(tmpdir(), "devspace-e2e-package-"));
  const consumer = join(root, "consumer");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  // The existing Windows package check takes about eight minutes in CI.
  const options = { encoding: "utf8" as const, timeout: 600_000, maxBuffer: 8 * 1024 * 1024,
    shell: process.platform === "win32" };
  try {
    await mkdir(consumer);
    console.info("E2E setup: packing the checkout");
    await exec(npm, ["pack", "--silent", "--pack-destination", root], { ...options, cwd: repository });
    const archive = (await readdir(root)).find((name) => name.endsWith(".tgz"));
    if (!archive) throw new Error("npm pack did not produce an archive");
    console.info("E2E setup: installing the packed consumer");
    await exec(npm, ["install", "--no-audit", "--no-fund", "--no-package-lock", "--no-save",
      "--omit=optional", join(root, archive)], { ...options, cwd: consumer });
    console.info("E2E setup: installed package ready");
    const directory = join(consumer, "node_modules", "@waishnav", "devspace");
    return { directory, close: () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
