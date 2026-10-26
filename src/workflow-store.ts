import { openDatabase, type DatabaseHandle } from "./db/client.js";
import type { LocalAgentWorkspaceScope } from "./local-agent-store.js";
import { WorkflowError, type WorkflowCall, type WorkflowEvent, type WorkflowSnapshot } from "./workflow-types.js";

/** Durable ownership is written before dispatch; a provider session is never an ownership key. */
export class WorkflowStore {
  private readonly database: DatabaseHandle;
  constructor(stateDir: string) { this.database = openDatabase(stateDir); }
  close(): void { this.database.close(); }

  create(run: WorkflowSnapshot): void {
    this.database.sqlite.prepare("insert into workflow_runs (id, workspace_root, workspace_id, record_json) values (?, ?, ?, ?)")
      .run(run.id, run.workspaceRoot, run.workspaceId ?? null, JSON.stringify(run));
  }
  get(id: string): WorkflowSnapshot | undefined {
    return decode<WorkflowSnapshot>(this.database.sqlite.prepare("select record_json from workflow_runs where id = ?").get(id));
  }
  list(scope?: LocalAgentWorkspaceScope): WorkflowSnapshot[] {
    const rows = scope
      ? this.database.sqlite.prepare("select record_json from workflow_runs where workspace_root = ? and workspace_id is ? order by rowid desc")
        .all(scope.workspaceRoot, scope.workspaceId ?? null)
      : this.database.sqlite.prepare("select record_json from workflow_runs order by rowid desc").all();
    return rows.map((row) => decode<WorkflowSnapshot>(row)!);
  }
  update(id: string, patch: Partial<Pick<WorkflowSnapshot, "status" | "result" | "error">>): WorkflowSnapshot {
    const run = this.get(id);
    if (!run) throw new WorkflowError("WORKFLOW_NOT_FOUND", `Unknown workflow run: ${id}`);
    Object.assign(run, patch, { updatedAt: new Date().toISOString() });
    this.database.sqlite.prepare("update workflow_runs set record_json = ? where id = ?").run(JSON.stringify(run), id);
    return run;
  }
  addCall(call: WorkflowCall): void {
    this.database.sqlite.transaction(() => {
      const run = this.get(call.runId)!;
      this.database.sqlite.prepare("insert into workflow_calls (run_id, call_index, agent_id, record_json) values (?, ?, ?, ?)")
        .run(call.runId, call.index, call.agentId, JSON.stringify(call));
      run.callCount++;
      run.updatedAt = new Date().toISOString();
      this.database.sqlite.prepare("update workflow_runs set record_json = ? where id = ?").run(JSON.stringify(run), run.id);
    })();
  }
  calls(runId: string): WorkflowCall[] {
    return this.database.sqlite.prepare("select record_json from workflow_calls where run_id = ? order by call_index").all(runId)
      .map((row) => decode<WorkflowCall>(row)!);
  }
  call(runId: string, index: number): WorkflowCall | undefined {
    return decode<WorkflowCall>(this.database.sqlite.prepare("select record_json from workflow_calls where run_id = ? and call_index = ?").get(runId, index));
  }
  updateCall(runId: string, index: number, patch: Partial<WorkflowCall>): WorkflowCall {
    const call = this.call(runId, index);
    if (!call) throw new WorkflowError("WORKFLOW_CALL_NOT_FOUND", `Unknown workflow call: ${index}`);
    Object.assign(call, patch, { updatedAt: new Date().toISOString() });
    this.database.sqlite.prepare("update workflow_calls set record_json = ? where run_id = ? and call_index = ?")
      .run(JSON.stringify(call), runId, index);
    return call;
  }
  event(runId: string, type: string, data: unknown): void {
    this.database.sqlite.prepare("insert into workflow_events (run_id, type, data_json, created_at) values (?, ?, ?, ?)")
      .run(runId, type, JSON.stringify(data), new Date().toISOString());
  }
  events(runId: string, after = 0): WorkflowEvent[] {
    const rows = this.database.sqlite.prepare("select * from workflow_events where run_id = ? and sequence > ? order by sequence limit 100").all(runId, after) as Array<{
      sequence: number; run_id: string; type: string; data_json: string; created_at: string;
    }>;
    return rows.map((r) => ({ sequence: r.sequence, runId: r.run_id, type: r.type, data: JSON.parse(r.data_json), createdAt: r.created_at }));
  }
}
function decode<T>(row: unknown): T | undefined {
  return row ? JSON.parse((row as { record_json: string }).record_json) as T : undefined;
}
