#!/usr/bin/env node
"use strict";

const {
  formatUnsupportedNodeMessage,
  isSupportedNodeVersion,
} = require("./node-version.cjs");

if (!isSupportedNodeVersion(process.versions.node)) {
  console.error(formatUnsupportedNodeMessage());
  process.exitCode = 1;
} else {
  import("../dist/cli.js").catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
