import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseWorkflowArgFlagsResult,
  persistWorkflowScriptResult,
  readProjectWorkflowScriptFileResult,
  resolveNamedWorkflowScriptResult,
  resolveWorkflowScriptFromPathOrNameResult,
} from "./workflow-files.js";
import {
  InvalidWorkflowInputError,
  NamedWorkflowNotFoundError,
} from "./workflow-errors.js";
import { hashSource } from "./workflow-script.js";

{
  const parsed = parseWorkflowArgFlagsResult([
    "--arg",
    "n=1",
    "--arg",
    'files=["a.ts"]',
    "--follow",
    "extra",
  ]);
  assert.equal(parsed.isOk(), true);
  if (parsed.isOk()) {
    assert.deepEqual(parsed.value.args, { n: 1, files: ["a.ts"] });
    assert.deepEqual(parsed.value.rest, ["--follow", "extra"]);
  }
}

{
  const dir = await mkdtemp(join(tmpdir(), "wf-files-"));
  const persisted = await persistWorkflowScriptResult({
    stateDir: dir,
    runId: "wfr_test",
    source: "export const meta = { name: 'x', description: 'd' }\nreturn 1\n",
    preferredName: "demo",
  });
  assert.equal(persisted.isOk(), true);
  if (!persisted.isOk()) throw persisted.error;
  const path = persisted.value;
  assert.match(path.replaceAll("\\", "/"), /workflow-scripts\/wfr_test\/demo\.js$/);

  const file = await resolveWorkflowScriptFromPathOrNameResult({
    file: path,
    workspaceRoot: dir,
  });
  assert.equal(file.isOk(), true);
  if (!file.isOk()) throw file.error;
  assert.equal(file.value.origin, "file");
  assert.equal(file.value.scriptHash, hashSource(file.value.source));

  await mkdir(join(dir, ".devspace", "workflows"), { recursive: true });
  await writeFile(
    join(dir, ".devspace", "workflows", "named.js"),
    "export const meta = { name: 'named', description: 'd' }\nreturn 2\n",
  );
  const named = await resolveNamedWorkflowScriptResult({
    name: "named",
    workspaceRoot: dir,
  });
  assert.equal(named.isOk(), true);
  if (!named.isOk()) throw named.error;
  assert.equal(named.value.origin, "named");
  assert.match(named.value.source, /named/);

  const projectRead = await readProjectWorkflowScriptFileResult({
    scriptPath: join(dir, ".devspace", "workflows", "named.js"),
    workspaceRoot: dir,
  });
  assert.equal(projectRead.isOk(), true);
  if (!projectRead.isOk()) throw projectRead.error;
  assert.equal(projectRead.value.nameHint, "named");

  const outsideProject = await readProjectWorkflowScriptFileResult({
    scriptPath: path,
    workspaceRoot: dir,
  });
  assert.equal(outsideProject.isErr(), true);
  if (outsideProject.isErr()) {
    assert.equal(InvalidWorkflowInputError.is(outsideProject.error), true);
    assert.match(outsideProject.error.message, /must be inside/);
  }

  if (process.platform !== "win32") {
    const outside = await mkdtemp(join(tmpdir(), "wf-files-outside-"));
    try {
      const outsideScript = join(outside, "escape.js");
      await writeFile(
        outsideScript,
        "export const meta = { name: 'escape', description: 'd' }\nreturn 4\n",
      );
      await symlink(
        outsideScript,
        join(dir, ".devspace", "workflows", "escape.js"),
      );
      const escaped = await readProjectWorkflowScriptFileResult({
        scriptPath: "escape.js",
        workspaceRoot: dir,
      });
      assert.equal(escaped.isErr(), true);
      if (escaped.isErr()) {
        assert.equal(InvalidWorkflowInputError.is(escaped.error), true);
        assert.match(escaped.error.message, /resolves outside/);
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  }

  await mkdir(join(dir, "workflows"), { recursive: true });
  await writeFile(
    join(dir, "workflows", "legacy.js"),
    "export const meta = { name: 'legacy', description: 'd' }\nreturn 3\n",
  );
  const legacy = await resolveNamedWorkflowScriptResult({
    name: "legacy",
    workspaceRoot: dir,
  });
  assert.equal(legacy.isErr(), true);
  if (legacy.isErr()) {
    assert.equal(NamedWorkflowNotFoundError.is(legacy.error), true);
  }

  const missing = await resolveNamedWorkflowScriptResult({
    name: "missing",
    workspaceRoot: dir,
  });
  assert.equal(missing.isErr(), true);
  if (missing.isErr()) {
    assert.equal(NamedWorkflowNotFoundError.is(missing.error), true);
  }

  await rm(dir, { recursive: true, force: true });
}

console.log("workflow-files.test.ts: ok");
