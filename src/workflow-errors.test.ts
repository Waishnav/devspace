import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyAgentProviderError,
  ProviderCancelledError,
  ProviderExecutionError,
  ProviderSchemaUnsupportedError,
} from "./local-agent-errors.js";
import {
  parseWorkflowArgFlagsResult,
  readWorkflowScriptFileResult,
  resolveNamedWorkflowScriptResult,
} from "./workflow-files.js";
import {
  InvalidRunTransitionError,
  InvalidWorkflowInputError,
  NamedWorkflowNotFoundError,
  SchemaRetriesExhaustedError,
  WorkflowFileNotFoundError,
  WorkflowNotFoundError,
  WorktreeOperationError,
  serializeWorkflowError,
  workflowCliExitCode,
  workflowErrorKind,
} from "./workflow-errors.js";
import { WorkflowStore } from "./workflow-store.js";
import { enforceAgentSchemaResult } from "./workflow-schema.js";
import { createWorkflowWorktreeResult } from "./workflow-worktrees.js";

{
  const invalid = parseWorkflowArgFlagsResult(["--arg", "missing-equals"]);
  assert.ok(invalid.isErr());
  if (invalid.isErr()) assert.ok(InvalidWorkflowInputError.is(invalid.error));
}

{
  const missing = await readWorkflowScriptFileResult("/definitely/missing/workflow.js");
  assert.ok(missing.isErr());
  if (missing.isErr()) assert.ok(WorkflowFileNotFoundError.is(missing.error));
}

{
  const root = await mkdtemp(join(tmpdir(), "wf-result-files-"));
  try {
    const missing = await resolveNamedWorkflowScriptResult({
      name: "missing",
      workspaceRoot: root,
    });
    assert.ok(missing.isErr());
    if (missing.isErr()) assert.ok(NamedWorkflowNotFoundError.is(missing.error));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

{
  const cancelled = Object.assign(new Error("cancel"), { name: "AbortError" });
  assert.ok(ProviderCancelledError.is(classifyAgentProviderError("codex", cancelled)));
  assert.ok(
    ProviderSchemaUnsupportedError.is(
      classifyAgentProviderError(
        "claude",
        new Error("structured output format is not supported"),
      ),
    ),
  );
  assert.ok(
    ProviderExecutionError.is(
      classifyAgentProviderError("opencode", new Error("authentication failed")),
    ),
  );

  const unavailable = new ProviderSchemaUnsupportedError(
    "codex",
    new Error("output schema unsupported"),
  );
  assert.equal(workflowCliExitCode(unavailable), 5);
  assert.deepEqual(serializeWorkflowError(unavailable), {
    code: "ProviderSchemaUnsupportedError",
    message: unavailable.message,
    kind: "schema",
    retryable: false,
  });
}

{
  const root = await mkdtemp(join(tmpdir(), "wf-result-store-"));
  const store = new WorkflowStore(root);
  try {
    const missing = store.claimRunResult("wfr_missing", process.pid);
    assert.ok(missing.isErr());
    if (missing.isErr()) assert.ok(WorkflowNotFoundError.is(missing.error));

    const run = store.createRun({
      name: "result-store",
      source: "inline",
      scriptPath: "inline",
      scriptHash: "h",
      workspaceRoot: root,
    });
    assert.ok(store.claimRunResult(run.id, process.pid).isOk());
    const duplicate = store.claimRunResult(run.id, process.pid);
    assert.ok(duplicate.isErr());
    if (duplicate.isErr()) assert.ok(InvalidRunTransitionError.is(duplicate.error));
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

{
  const exhausted = await enforceAgentSchemaResult({
    schema: { type: "object" },
    prompt: "return json",
    provider: "opencode",
    maxRetries: 0,
    run: async () => ({ finalResponse: "not json" }),
  });
  assert.ok(exhausted.isErr());
  if (exhausted.isErr()) {
    assert.ok(SchemaRetriesExhaustedError.is(exhausted.error));
    assert.equal(workflowErrorKind(exhausted.error), "schema");
  }
}

{
  const root = await mkdtemp(join(tmpdir(), "wf-result-worktree-"));
  try {
    const created = await createWorkflowWorktreeResult(
      { worktreeRoot: join(root, "worktrees") },
      {
        runId: "wfr_result",
        callIndex: 0,
        workspaceRoot: root,
      },
    );
    assert.ok(created.isErr());
    if (created.isErr()) {
      assert.ok(WorktreeOperationError.is(created.error));
      assert.equal(workflowErrorKind(created.error), "worktree");
      assert.ok(created.error.cause);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

console.log("workflow-errors.test.ts: ok");
