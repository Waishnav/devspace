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
    const home = process.env.HOME || "";
    const nvmAliasDir = join(home, ".nvm/alias");

    const resolveNvmAlias = (alias: string): string => {
      let cur = alias.toLowerCase().trim();
      // Follow alias files up to 5 levels (e.g. lts/* -> lts/krypton -> v24.21.0)
      for (let depth = 0; depth < 5; depth++) {
        let candidatePath = "";
        if (cur.startsWith("lts/")) {
          candidatePath = join(nvmAliasDir, "lts", cur.slice(4));
        } else if (cur === "lts" || cur === "lts/*") {
          candidatePath = join(nvmAliasDir, "lts", "*");
        } else {
          candidatePath = join(nvmAliasDir, cur);
        }
        if (existsSync(candidatePath)) {
          try {
            const target = readFileSync(candidatePath, "utf8").trim();
            if (target) {
              cur = target;
              continue;
            }
          } catch {}
        }
        break;
      }
      return cur;
    };

    if (versionStr) {
      let normalized = versionStr.toLowerCase().trim();
      // If versionStr refers to an alias or LTS identifier, resolve it dynamically via NVM metadata
      if (normalized.includes("lts") || !/^\d/.test(normalized)) {
        normalized = resolveNvmAlias(normalized);
      }
      // Fallback known LTS names if NVM alias folder was not present
      if (normalized === "lts/*" || normalized === "lts" || normalized === "lts/jod") {
        targetMajor = 22;
      } else if (normalized === "lts/iron") {
        targetMajor = 20;
      } else if (normalized === "lts/hydrogen") {
        targetMajor = 18;
      } else {
        // Match leading major version (e.g. "22", "v22", ">=22", "22.x", "v20.22.1" -> 20)
        const match = normalized.match(/(?:^|[^\d])v?(\d+)(?:\.|\b)/);
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
