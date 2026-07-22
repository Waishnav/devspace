"use strict";

const SUPPORTED_NODE_RANGE = ">=22.19 <27";

function parseNodeVersion(version) {
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function isSupportedNodeVersion(version) {
  const parsed = parseNodeVersion(version);
  if (!parsed) return false;

  return (
    (parsed.major === 22 && parsed.minor >= 19) ||
    (parsed.major > 22 && parsed.major < 27)
  );
}

function formatUnsupportedNodeMessage(version = process.versions.node) {
  const displayVersion = version.startsWith("v") ? version : `v${version}`;

  return [
    `DevSpace requires Node.js ${SUPPORTED_NODE_RANGE}.`,
    `Current Node.js: ${displayVersion}`,
    "",
    "Install or switch to Node.js 22 LTS, then retry:",
    "",
    "  nvm install 22 && nvm use 22",
    "  mise use --global node@22",
    "",
    "Then rerun your DevSpace installation.",
  ].join("\n");
}

module.exports = {
  SUPPORTED_NODE_RANGE,
  formatUnsupportedNodeMessage,
  isSupportedNodeVersion,
};
