import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCliEntry } from "./workflow-cli-entry.js";
import { launchWorkflowRun } from "./workflow-launch.js";
import { WorkflowStore } from "./workflow-store.js";

const script = (name: string, value = 1) =>
  `export const meta = { name: '${name}', description: 'd' }\nreturn ${value}\n`;

{
  const dir = await mkdtemp(join(tmpdir(), "wf-launch-"));
  const store = new WorkflowStore(dir);
  const common = {
    store,
    config: { stateDir: dir },
    workspaceRoot: dir,
    workspaceId: "ws_owner",
    scriptFileScope: "local" as const,
    cliEntry: "/tmp/devspace-cli-not-used",
    spawn: false,
  };

  const launched = await launchWorkflowRun({
    ...common,
    source: {
      kind: "inline",
      script: `export const meta = { name: 'launch-demo', description: 'd', phases: [{ title: 'Plan' }, { title: 'Build', detail: 'Implement it' }] }\nreturn 1\n`,
    },
    args: { n: 1 },
  });
  if (launched.isErr()) throw launched.error;
  assert.equal(launched.value.run.status, "starting");
  assert.equal(launched.value.run.argsJson, JSON.stringify({ n: 1 }));
  assert.deepEqual(launched.value.run.phases, [
    { title: "Plan" },
    { title: "Build", detail: "Implement it" },
  ]);

  const workflowDir = join(dir, ".devspace", "workflows");
  await mkdir(workflowDir, { recursive: true });
  await writeFile(join(workflowDir, "named.js"), script("named", 2));
  await writeFile(join(dir, "file.js"), script("file", 3));

  const named = await launchWorkflowRun({
    ...common,
    source: { kind: "named", name: "named" },
  });
  assert.ok(named.isOk());
  if (named.isOk()) assert.equal(named.value.source, "named");

  const file = await launchWorkflowRun({
    ...common,
    source: { kind: "file", path: "file.js" },
  });
  assert.ok(file.isOk());
  if (file.isOk()) assert.equal(file.value.source, "file");

  const resumed = await launchWorkflowRun({
    ...common,
    source: {
      kind: "resume",
      runId: launched.value.run.id,
      override: { kind: "file", path: "named.js" },
    },
    scriptFileScope: "project-workflows",
  });
  assert.ok(resumed.isOk());
  if (resumed.isOk()) {
    assert.equal(resumed.value.source, "resume");
    assert.equal(resumed.value.run.argsJson, JSON.stringify({ n: 1 }));
  }

  const outside = await launchWorkflowRun({
    ...common,
    source: { kind: "file", path: join(dir, "file.js") },
    scriptFileScope: "project-workflows",
  });
  assert.ok(outside.isErr());

  const crossWorkspace = await launchWorkflowRun({
    ...common,
    workspaceId: "ws_other",
    source: { kind: "resume", runId: launched.value.run.id },
  });
  assert.ok(crossWorkspace.isErr());

  store.close();
  await rm(dir, { recursive: true, force: true });
}

{
  assert.match(resolveCliEntry().replaceAll("\\", "/"), /\/src\/cli\.ts$/);
  const dir = await mkdtemp(join(tmpdir(), "wf-launch-failure-"));
  const stateFile = join(dir, "not-a-directory");
  await writeFile(stateFile, "blocked");
  const store = new WorkflowStore(join(dir, "store"));
  const failed = await launchWorkflowRun({
    store,
    config: { stateDir: stateFile },
    workspaceRoot: dir,
    source: { kind: "inline", script: script("failure") },
    scriptFileScope: "local",
    cliEntry: "/tmp/devspace-cli-not-used",
    spawn: false,
  });
  assert.ok(failed.isErr());
  assert.equal(store.listRuns(1)[0]?.status, "failed");
  store.close();
  await rm(dir, { recursive: true, force: true });
}

console.log("workflow-launch.test.ts: ok");
