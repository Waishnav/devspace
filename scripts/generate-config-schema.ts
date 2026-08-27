import { mkdirSync, writeFileSync } from "node:fs";
import {
  devspaceConfigJsonSchema,
} from "../src/config-schema.js";

const outputPath = new URL("../schema/v1/devspace.schema.json", import.meta.url);

mkdirSync(new URL(".", outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(devspaceConfigJsonSchema(), null, 2)}\n`);
