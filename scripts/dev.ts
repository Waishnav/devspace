import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import spawn from "cross-spawn";

const checkoutRoot = resolve(process.cwd());
const configDir = join(checkoutRoot, ".devspace-dev", "config");
const hasConfig = existsSync(join(configDir, "config.jsonc")) || existsSync(join(configDir, "config.json"));

if (!hasConfig) {
  console.error("Development state is not initialized. Run `pnpm dev:seed` first.");
  process.exitCode = 1;
} else {
  const child = spawn("tsx", ["watch", "--clear-screen=false", "src/cli.ts", "serve"], {
    cwd: checkoutRoot,
    env: {
      ...process.env,
      DEVSPACE_CONFIG_DIR: configDir,
    },
    stdio: "inherit",
  });

  child.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
}
