// node:sqlite is a release candidate but still emits an ExperimentalWarning in every process that loads it.
// Built-ins load while the ES module graph links, before any app code runs, so this filter must be preloaded:
// run-entrypoint.js imports it first, and the agent daemon receives it through `--import`.
const emitWarning = process.emitWarning;

process.emitWarning = function (warning, ...args) {
  const type = typeof args[0] === "string" ? args[0] : args[0]?.type;
  const message = typeof warning === "string" ? warning : warning?.message;

  if (type === "ExperimentalWarning" && message?.startsWith("SQLite")) return;
  return emitWarning.call(process, warning, ...args);
};
