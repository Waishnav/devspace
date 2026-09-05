#!/usr/bin/env node
import { runEntrypoint } from "./run-entrypoint.js";

await runEntrypoint("../src/local-agent-daemon-main.ts", "../dist/local-agent-daemon-main.js");
