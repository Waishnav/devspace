import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export function resolveProjectEnvironment(workspaceRoot?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: process.env.HOME || "",
    USER: process.env.USER || "",
    SHELL: process.env.SHELL || "/bin/bash",
  };

  let preferNode22 = false;
  if (workspaceRoot) {
    const nvmrcPath = join(workspaceRoot, ".nvmrc");
    const nodeVersionPath = join(workspaceRoot, ".node-version");
    const packageJsonPath = join(workspaceRoot, "package.json");

    if (existsSync(nvmrcPath)) {
      const v = readFileSync(nvmrcPath, "utf8").trim();
      if (v.startsWith("22") || v.includes("lts")) preferNode22 = true;
    } else if (existsSync(nodeVersionPath)) {
      const v = readFileSync(nodeVersionPath, "utf8").trim();
      if (v.startsWith("22")) preferNode22 = true;
    } else if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { engines?: { node?: string } };
        if (pkg.engines?.node && (pkg.engines.node.includes("22") || pkg.engines.node.includes("<25"))) {
          preferNode22 = true;
        }
      } catch {}
    }
  }

  const currentPath = process.env.PATH || "";
  if (preferNode22) {
    const home = process.env.HOME || "";
    const nvmNode22 = join(home, ".nvm/versions/node/v22.23.2/bin");
    if (existsSync(nvmNode22)) {
      env.PATH = `${nvmNode22}:${currentPath}`;
    }
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
