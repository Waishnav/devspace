import { createRequire } from "node:module";
import { z } from "zod";

const require = createRequire(import.meta.url);

const packageJson = z.object({ version: z.string().min(1) }).parse(require("../package.json"));

export const DEVSPACE_VERSION = packageJson.version;
