// node:sqlite is a release candidate but still emits an ExperimentalWarning in every process that loads it.
// Built-ins load while the ES module graph links, before any app code runs, so this filter must be preloaded:
// run-entrypoint.js imports it first, and the agent daemon receives it through `--import`.
const emitWarning = process.emitWarning;

process.emitWarning = function (warning, ...args) {
  // emitWarning(warning, type) and emitWarning(warning, { type }) are both valid call shapes.
  const type = args[0]?.type ?? args[0];
  const message = String(warning?.message ?? warning);

  if (type === "ExperimentalWarning" && message.startsWith("SQLite")) return;

  return emitWarning.call(process, warning, ...args);
};
