import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverInstructionPaths } from "./workspace-instruction-discovery.js";

test("instruction discovery preserves filename, skip, and symlink semantics", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-instruction-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const rootInstructions = join(root, "AGENTS.md");
  const supported = [
    join(root, "apps", "AGENTS.md"),
    join(root, "apps-uppercase", "AGENTS.MD"),
    join(root, "packages", "CLAUDE.md"),
    join(root, "packages-uppercase", "CLAUDE.MD"),
  ];
  await Promise.all(
    ["apps", "apps-uppercase", "packages", "packages-uppercase"].map((directory) =>
      mkdir(join(root, directory), { recursive: true }),
    ),
  );
  await mkdir(join(root, "node_modules", "dependency"), { recursive: true });
  await writeFile(rootInstructions, "root\n");
  await Promise.all(supported.map((path) => writeFile(path, "nested\n")));
  await writeFile(join(root, "apps", "agents.md"), "unsupported casing\n");
  await writeFile(join(root, "node_modules", "dependency", "AGENTS.md"), "skipped\n");

  if (platform() !== "win32") {
    await mkdir(join(root, "links"));
    await symlink(supported[0], join(root, "links", "AGENTS.md"));
    await symlink(join(root, "apps"), join(root, "linked-apps"));
  }

  const nodeResult = await discoverInstructionPaths(root, {
    excludedPaths: new Set([rootInstructions]),
    finder: "node",
  });
  const automaticResult = await discoverInstructionPaths(root, {
    excludedPaths: new Set([rootInstructions]),
  });

  assert.equal(nodeResult.status, "complete");
  assert.equal(automaticResult.status, "complete");
  assert.deepEqual(nodeResult.paths, supported.sort((a, b) => a.localeCompare(b)));
  assert.deepEqual(automaticResult.paths, nodeResult.paths);
});

test("instruction discovery discards partial results when its count or byte budget is exceeded", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-instruction-limits-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  for (let index = 0; index < 3; index += 1) {
    const directory = join(root, `project-${index}`);
    await mkdir(directory);
    await writeFile(join(directory, "AGENTS.md"), "instructions\n");
  }

  const atCountLimit = await discoverInstructionPaths(root, {
    finder: "node",
    limits: { maxFiles: 3 },
  });
  const overCountLimit = await discoverInstructionPaths(root, {
    finder: "node",
    limits: { maxFiles: 2 },
  });
  const overByteLimit = await discoverInstructionPaths(root, {
    finder: "node",
    limits: { maxPathBytes: 1 },
  });

  assert.equal(atCountLimit.status, "complete");
  assert.equal(atCountLimit.paths.length, 3);
  assert.deepEqual(overCountLimit, {
    status: "incomplete",
    finder: "node",
    reason: "result_limit_exceeded",
    paths: [],
  });
  assert.deepEqual(overByteLimit, {
    status: "incomplete",
    finder: "node",
    reason: "result_limit_exceeded",
    paths: [],
  });
});

test("instruction discovery reports an exhausted deadline without returning partial paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-instruction-deadline-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(
    await discoverInstructionPaths(root, {
      finder: "node",
      limits: { maxDurationMs: 0 },
    }),
    {
      status: "incomplete",
      finder: "node",
      reason: "deadline_exceeded",
      paths: [],
    },
  );
});

test("node discovery checks its deadline while iterating a wide directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-instruction-wide-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await Promise.all(
    Array.from({ length: 64 }, (_, index) => mkdir(join(root, `project-${index}`))),
  );
  let now = 0;
  t.mock.method(performance, "now", () => now++);

  assert.deepEqual(
    await discoverInstructionPaths(root, {
      finder: "node",
      limits: { maxDurationMs: 3 },
    }),
    {
      status: "incomplete",
      finder: "node",
      reason: "deadline_exceeded",
      paths: [],
    },
  );
});

test("node discovery checks its deadline before reporting completion", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-instruction-completion-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const timestamps = [0, 0, 0, 20_000];
  t.mock.method(performance, "now", () => timestamps.shift() ?? 20_000);

  assert.deepEqual(
    await discoverInstructionPaths(root, {
      finder: "node",
      limits: { maxDurationMs: 10_000 },
    }),
    {
      status: "incomplete",
      finder: "node",
      reason: "deadline_exceeded",
      paths: [],
    },
  );
});

test("node discovery preserves a result limit reached before its deadline", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-instruction-first-limit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "AGENTS.md"), "instructions\n");

  const timestamps = [0, 0, 0, 0, 20_000];
  t.mock.method(performance, "now", () => timestamps.shift() ?? 20_000);

  assert.deepEqual(
    await discoverInstructionPaths(root, {
      finder: "node",
      limits: { maxFiles: 0, maxDurationMs: 10_000 },
    }),
    {
      status: "incomplete",
      finder: "node",
      reason: "result_limit_exceeded",
      paths: [],
    },
  );
});
