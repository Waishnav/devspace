import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export function resolveProjectEnvironment(workspaceRoot?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: process.env.HOME || "",
    USER: process.env.USER || "",
    SHELL: process.env.SHELL || "/bin/bash",
  };

  let targetMajor: number | null = null;
  if (workspaceRoot) {
    const nvmrcPath = join(workspaceRoot, ".nvmrc");
    const nodeVersionPath = join(workspaceRoot, ".node-version");
    const packageJsonPath = join(workspaceRoot, "package.json");

    let versionStr = "";
    if (existsSync(nvmrcPath)) {
      versionStr = readFileSync(nvmrcPath, "utf8").trim();
    } else if (existsSync(nodeVersionPath)) {
      versionStr = readFileSync(nodeVersionPath, "utf8").trim();
    } else if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { engines?: { node?: string } };
        versionStr = pkg.engines?.node || "";
      } catch {}
    }

    if (versionStr) {
      if (versionStr.includes("lts") || versionStr.includes("22")) {
        targetMajor = 22;
      } else {
        const match = versionStr.match(/(\d+)/);
        if (match) {
          targetMajor = parseInt(match[1], 10);
        }
      }
    }
  }

  const currentPath = process.env.PATH || "";
  const home = process.env.HOME || "";
  const nvmVersionsDir = join(home, ".nvm/versions/node");

  // Fix finding 5: Discover any installed Node version matching targetMajor dynamically
  if (targetMajor !== null && existsSync(nvmVersionsDir)) {
    try {
      const installed = readdirSync(nvmVersionsDir);
      // Look for versions matching `v<targetMajor>.*`, sort descending to pick latest installed patch
      const matched = installed
        .filter((dir) => dir.startsWith(`v${targetMajor}.`))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

      if (matched.length > 0) {
        const selectedBin = join(nvmVersionsDir, matched[0], "bin");
        if (existsSync(selectedBin)) {
          env.PATH = `${selectedBin}:${currentPath}`;
        }
      }
    } catch {}
  }

  return env;
}

export function getRuntimeDiagnostics(workspaceRoot?: string) {
  const env = resolveProjectEnvironment(workspaceRoot);

  const safeRun = (cmd: string, args: string[]) => {
    try {
      return execFileSync(cmd, args, { env, encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  };

  return {
    nodeVersion: safeRun("node", ["--version"]),
    npmVersion: safeRun("npm", ["--version"]),
    gitVersion: safeRun("git", ["--version"]),
    shell: env.SHELL || "/bin/bash",
    user: env.USER || "unknown",
  };
}
