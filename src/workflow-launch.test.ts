import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowStore } from "./workflow-store.js";
import { launchWorkflowRun } from "./workflow-launch.js";

{
  const dir = await mkdtemp(join(tmpdir(), "wf-launch-"));
  const store = new WorkflowStore(dir);
  const launched = await launchWorkflowRun({
    store,
    config: { stateDir: dir },
    workspaceRoot: dir,
    source: {
      kind: "inline",
      script: `export const meta = { name: 'launch-demo', description: 'd' }\nreturn 1\n`,
    },
    args: { n: 1 },
    cliEntry: "/tmp/devspace-cli-not-used",
    spawn: false,
  });
  assert.equal(launched.isOk(), true);
  if (!launched.isOk()) throw launched.error;
  assert.equal(launched.value.run.name, "launch-demo");
  assert.equal(launched.value.run.status, "starting");
  assert.match(launched.value.run.scriptPath.replaceAll("\\", "/"), /workflow-scripts\//);
  assert.equal(launched.value.run.argsJson, JSON.stringify({ n: 1 }));

  await mkdir(join(dir, ".devspace", "workflows"), { recursive: true });
  await writeFile(
    join(dir, ".devspace", "workflows", "named-wf.js"),
    `export const meta = { name: 'named-wf', description: 'd' }\nreturn 2\n`,
  );
  const named = await launchWorkflowRun({
    store,
    config: { stateDir: dir },
    workspaceRoot: dir,
    source: { kind: "named", name: "named-wf" },
    cliEntry: "/tmp/devspace-cli-not-used",
    spawn: false,
  });
  assert.equal(named.isOk(), true);
  if (!named.isOk()) throw named.error;
  assert.equal(named.value.source, "named");
  assert.equal(named.value.run.name, "named-wf");

  const resumed = await launchWorkflowRun({
    store,
    config: { stateDir: dir },
    workspaceRoot: dir,
    source: { kind: "resume", runId: launched.value.run.id },
    cliEntry: "/tmp/devspace-cli-not-used",
    spawn: false,
  });
  assert.equal(resumed.isOk(), true);
  if (!resumed.isOk()) throw resumed.error;
  assert.equal(resumed.value.source, "resume");
  assert.equal(resumed.value.run.resumedFromRunId, launched.value.run.id);
  assert.equal(resumed.value.run.argsJson, JSON.stringify({ n: 1 }));

  store.close();
  await rm(dir, { recursive: true, force: true });
}

console.log("workflow-launch.test.ts: ok");
