#!/usr/bin/env node
import { runEntrypoint } from "./run-entrypoint.js";

await runEntrypoint("../src/cli.ts", "../dist/cli.js");
