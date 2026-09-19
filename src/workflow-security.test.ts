import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "./db/client.js";
import { defaultWorkflowsConfig } from "./workflow-config.js";
import { createWorkflowManager } from "./workflow-manager.js";
import { LocalAgentStore } from "./local-agent-store.js";
import type { LocalAgentManager } from "./local-agent-manager.js";
import { WorkflowStore } from "./workflow-store.js";

test("inline workflow launch cannot write its artifact through an escaping .devspace symlink", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "workflow-security-")));
  const project = join(root, "project");
  const outside = join(root, "outside");
  await mkdir(project); await mkdir(outside);
  await symlink(outside, join(project, ".devspace"));
  const database = openDatabase(join(root, "state"));
  const agentStore = new LocalAgentStore(database);
  const manager = createWorkflowManager({
    stateDir: join(root, "state"), agentStore, store: new WorkflowStore(database),
    agents: {} as LocalAgentManager,
    config: { ...defaultWorkflowsConfig(), enabled: true },
    validateScope: async (scope) => {
      assert.deepEqual(scope, { workspaceId: "ws-test", workspaceRoot: project }); return scope;
    },
  });
  t.after(async () => { await manager.close(); database.close(); await rm(root, { recursive: true, force: true }); });
  const result = await manager.request({ operation: "run", scope: { workspaceId: "ws-test", workspaceRoot: project },
    input: { script: 'export const meta = {name: "escape", description: "Test"}; return null;' } });
  assert.equal(result.ok, false);
  assert.deepEqual(await readdir(outside), []);
  assert.equal(manager.activeRunCount, 0);
});
