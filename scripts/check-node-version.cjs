#!/usr/bin/env node
"use strict";

const {
  formatUnsupportedNodeMessage,
  isSupportedNodeVersion,
} = require("./node-version.cjs");

if (!isSupportedNodeVersion(process.versions.node)) {
  console.error(formatUnsupportedNodeMessage());
  process.exit(1);
}
