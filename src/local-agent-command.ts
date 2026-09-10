import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";

export function resolveExecutableCommand(
  command: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (!command) return undefined;
  if (command.includes("/") || command.includes("\\")) {
    return isExecutableFile(command) ? command : undefined;
  }
  const path = env.PATH;
  if (!path) return undefined;
  const extensions = process.platform === "win32"
    ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
    : [""];
  for (const directory of path.split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = resolve(directory, `${command}${extension}`);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

function isExecutableFile(command: string): boolean {
  const mode = process.platform === "win32" ? constants.F_OK : constants.X_OK;
  try {
    accessSync(command, mode);
    return statSync(command).isFile();
  } catch {
    return false;
  }
}
