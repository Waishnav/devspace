import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { defaultDevspaceConfig } from "../src/config-schema.js";
import { writeDevspaceConfig } from "../src/user-config.js";

const execute = promisify(execFile);
// Run after compiling dist. No installation and no live provider credentials are needed.
test("compiled CLI coordinates a real daemon, adapter process, managed worktree, and persisted replay", { skip: process.platform === "win32" }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "devspace-workflow-package-")));
  const project = join(root, "project");
  const configDir = join(root, "config");
  await mkdir(project);
  const command = join(root, "fake-codex.mjs");
  await writeFile(command, `#!/usr/bin/env node
import readline from 'node:readline';
if (process.argv.includes('--version')) { console.log('codex-cli 9.8.7'); process.exit(0); }
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const threads = new Map(); let sequence = 0;
readline.createInterface({input: process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return send({id:m.id,result:{userAgent:'fake'}});
  if (m.method === 'thread/start' || m.method === 'thread/resume') {
    const id = m.params.threadId || 'thread_' + ++sequence; threads.set(id, m.params);
    return send({id:m.id,result:{thread:{id}}});
  }
  if (m.method === 'turn/start') {
    const id = 'turn_' + ++sequence, threadId = m.params.threadId;
    send({id:m.id,result:{turn:{id}}});
    const item = {type:'agentMessage',text:JSON.stringify({cwd:threads.get(threadId).cwd,
      sandbox:m.params.sandboxPolicy.type, provenance:process.env.DEVSPACE_WORKFLOW_RUN_ID})};
    setImmediate(() => {
      send({method:'item/completed',params:{threadId,turnId:id,item}});
      send({method:'thread/tokenUsage/updated',params:{threadId,turnId:id,tokenUsage:{last:{inputTokens:1,outputTokens:2}}}});
      send({method:'turn/completed',params:{threadId,turn:{id,status:'completed',items:[item]}}});
    }); return;
  }
  if (m.id !== undefined) send({id:m.id,result:{}});
});
`, { mode: 0o700 });
  const git = (args: string[]) => execute("git", args, { cwd: project });
  await git(["init"]);
  await writeFile(join(project, "README.md"), "fixture\n");
  await git(["add", "README.md"]);
  await git(["-c", "user.name=DevSpace Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]);
  await mkdir(join(project, ".devspace", "agents"), { recursive: true });
  await writeFile(join(project, ".devspace", "agents", "local-reviewer.md"),
    "---\nname: local-reviewer\ndescription: Untracked project profile\nprovider: codex\nwriteMode: read_only\n---\nInspect the project.\n");
  await writeFile(join(project, "workflow.js"), `export const meta = {name:'package-smoke',description:'Packaged adapter path'};
return await agent('inspect', {isolation:'worktree',schema:{type:'object'}});`);
  const config = defaultDevspaceConfig();
  config.workspaces.allowedRoots = [project];
  config.workspaces.worktreeRoot = join(root, "worktrees");
  config.storage.stateDir = join(root, "state");
  config.subagents = { enabled: true, instructions: "on-demand", providers: [{id:"codex", enabled:true, command}] };
  config.workflows.enabled = true; config.workflows.defaultAgentType = "local-reviewer";
  writeDevspaceConfig(config, {DEVSPACE_CONFIG_DIR: configDir});
  const env: NodeJS.ProcessEnv = {...process.env, DEVSPACE_CONFIG_DIR: configDir, DEVSPACE_OAUTH_OWNER_TOKEN:"package-test-owner-token", DEVSPACE_AGENTD_IDLE_TIMEOUT_MS:"60000"};
  delete env.DEVSPACE_WORKFLOW_RUN_ID;
  const cli = resolve("dist/cli.js");
  await access(cli);
  const run = async (args: string[]) => JSON.parse((await execute(process.execPath, [cli, ...args, "--json"], {
    cwd:project, env, timeout:15000, maxBuffer:4*1024*1024,
  })).stdout);
  try {
    const receipt = await run(["workflows", "run", "workflow.js"]);
    let snapshot: any;
    for (let index=0; index<20; index++) {
      snapshot = await run(["workflows", "wait", receipt.runId, "--timeout", "1"]);
      if (["completed","failed","stopped","recovery_required"].includes(snapshot.state)) break;
    }
    assert.equal(snapshot.state, "completed", JSON.stringify(snapshot));
    assert.equal(snapshot.result.sandbox, "readOnly");
    assert.equal(snapshot.result.provenance, receipt.runId);
    assert.ok(snapshot.result.cwd.startsWith(config.workspaces.worktreeRoot));
    assert.notEqual(snapshot.result.cwd, project);
    assert.equal(snapshot.worktrees[0].path, snapshot.result.cwd);
    assert.equal(snapshot.worktrees[0].changed, false);
    assert.equal(snapshot.usage.knownOutputTokens, 2);
    await access(receipt.scriptPath);
    await access(join(receipt.transcriptDir, "journal.jsonl"));
    await access(join(receipt.transcriptDir, "result.json"));
    const saved = await run(["workflows","save",receipt.runId,"--name","saved-smoke"]);
    await access(saved.sourcePath);
    const resumed = await run(["workflows","run","workflow.js","--resume-from",receipt.runId]);
    const replay = await run(["workflows","wait",resumed.runId,"--timeout","2"]);
    assert.equal(replay.state,"completed",JSON.stringify(replay));
    assert.equal(replay.counts.cached,1);
    assert.equal(replay.usage.knownOutputTokens,2);
    await writeFile(join(project, "large.js"), "export const meta = {name:'large',description:'Large result'}; return 'x'.repeat(70000);");
    const large = await run(["workflows", "run", "large.js"]);
    const largeResult = await run(["workflows", "wait", large.runId, "--timeout", "2"]);
    assert.equal(largeResult.state, "completed");
    assert.equal(largeResult.result, undefined);
    assert.equal(JSON.parse(await readFile(largeResult.resultArtifact.path, "utf8")).length, 70000);
  } finally {
    await run(["agents","daemon","stop"]).catch(() => undefined);
    await rm(root,{recursive:true,force:true});
  }
});
