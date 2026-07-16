import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { openDatabase, type DatabaseHandle } from "../db/client.js";
import {
  WORKFLOW_DEFINITION_VERSION,
  WORKFLOW_POLICY_VERSION,
  type JsonObject,
  type JsonValue,
  type SubmitWorkflowRequest,
  type SubmitWorkflowResult,
  type WorkflowDefinition,
  type WorkflowEdgeRecord,
  type WorkflowEvent,
  type WorkflowEventPage,
  type WorkflowEventReadOptions,
  type WorkflowNodeClaim,
  type WorkflowNodeDefinitionV1,
  type WorkflowNodeRecord,
  type WorkflowNodeStatus,
  type WorkflowNodeTransition,
  type WorkflowPolicy,
  type WorkflowRunRecord,
  type WorkflowStatus,
  type WorkflowTransition,
} from "./types.js";

const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;
const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 1_000;
const DEFAULT_CLAIM_LEASE_MS = 5 * 60_000;
const MAX_CLAIM_LEASE_MS = 24 * 60 * 60_000;

const TERMINAL_WORKFLOW_STATUSES = new Set<WorkflowStatus>([
  "succeeded",
  "failed",
  "cancelled",
]);
const TERMINAL_NODE_STATUSES = new Set<WorkflowNodeStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
]);

const WORKFLOW_TRANSITIONS: Readonly<Record<WorkflowStatus, ReadonlySet<WorkflowStatus>>> = {
  queued: new Set(["running", "cancelling", "failed", "cancelled"]),
  running: new Set(["cancelling", "succeeded", "failed", "cancelled"]),
  cancelling: new Set(["succeeded", "failed", "cancelled"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

const NODE_TRANSITIONS: Readonly<Record<WorkflowNodeStatus, ReadonlySet<WorkflowNodeStatus>>> = {
  pending: new Set(["ready", "cancelled", "skipped"]),
  ready: new Set(["running", "cancelled", "skipped"]),
  running: new Set(["succeeded", "failed", "cancelled"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  skipped: new Set(),
};

interface WorkflowRunRow {
  id: string;
  definition_version: number;
  status: string;
  definition_json: string;
  input_json: string;
  policy_json: string;
  idempotency_key: string | null;
  request_hash: string;
  result_json: string | null;
  error_json: string | null;
  cancellation_requested_at: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface WorkflowNodeRow {
  id: string;
  workflow_run_id: string;
  node_key: string;
  node_type: string;
  status: string;
  definition_json: string;
  attempt: number;
  claim_token: string | null;
  claimed_at: string | null;
  claim_expires_at: string | null;
  result_json: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface WorkflowEdgeRow {
  workflow_run_id: string;
  from_node_id: string;
  to_node_id: string;
  from_key: string;
  to_key: string;
}

interface WorkflowEventRow {
  workflow_run_id: string;
  sequence: number;
  event_type: string;
  node_id: string | null;
  payload_json: string;
  created_at: string;
}

export class WorkflowNotFoundError extends Error {
  constructor(workflowId: string) {
    super(`Unknown workflow: ${workflowId}`);
    this.name = "WorkflowNotFoundError";
  }
}

export class WorkflowIdempotencyConflictError extends Error {
  constructor(idempotencyKey: string) {
    super(`Idempotency key was already used for a different workflow request: ${idempotencyKey}`);
    this.name = "WorkflowIdempotencyConflictError";
  }
}

export class WorkflowTransitionError extends Error {
  constructor(entity: "workflow" | "node", from: string, to: string) {
    super(`Illegal ${entity} status transition: ${from} -> ${to}`);
    this.name = "WorkflowTransitionError";
  }
}

export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowValidationError";
  }
}

export class WorkflowStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  submit(request: SubmitWorkflowRequest): SubmitWorkflowResult {
    const normalized = normalizeSubmission(request);
    const now = new Date().toISOString();
    const workflowId = createId("wf_");
    const nodeIds = new Map(normalized.definition.nodes.map((node) => [node.key, createId("wfn_")]));

    const save = this.database.sqlite.transaction(() => {
      if (normalized.idempotencyKey) {
        const existing = this.database.sqlite
          .prepare("select id, request_hash from workflow_runs where idempotency_key = ?")
          .get(normalized.idempotencyKey) as { id: string; request_hash: string } | undefined;
        if (existing) {
          if (existing.request_hash !== normalized.requestHash) {
            throw new WorkflowIdempotencyConflictError(normalized.idempotencyKey);
          }
          return { workflowId: existing.id, created: false };
        }
      }

      this.database.sqlite
        .prepare(
          `insert into workflow_runs (
            id, definition_version, status, definition_json, input_json, policy_json,
            idempotency_key, request_hash, created_at, updated_at
          ) values (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          workflowId,
          WORKFLOW_DEFINITION_VERSION,
          normalized.definitionJson,
          normalized.inputJson,
          normalized.policyJson,
          normalized.idempotencyKey ?? null,
          normalized.requestHash,
          now,
          now,
        );

      const incoming = new Map(normalized.definition.nodes.map((node) => [node.key, 0]));
      for (const edge of normalized.definition.edges ?? []) {
        incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
      }

      const insertNode = this.database.sqlite.prepare(
        `insert into workflow_nodes (
          id, workflow_run_id, node_key, node_type, status, definition_json,
          created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const node of normalized.definition.nodes) {
        insertNode.run(
          nodeIds.get(node.key),
          workflowId,
          node.key,
          node.type,
          incoming.get(node.key) === 0 ? "ready" : "pending",
          canonicalJson(node),
          now,
          now,
        );
      }

      const insertEdge = this.database.sqlite.prepare(
        `insert into workflow_edges (workflow_run_id, from_node_id, to_node_id)
         values (?, ?, ?)`,
      );
      for (const edge of normalized.definition.edges ?? []) {
        insertEdge.run(workflowId, nodeIds.get(edge.from), nodeIds.get(edge.to));
      }

      this.insertEvent(workflowId, "workflow.submitted", undefined, { status: "queued" }, now);
      return { workflowId, created: true };
    });

    const saved = save.immediate();
    return { workflow: this.require(saved.workflowId), created: saved.created };
  }

  get(workflowId: string): WorkflowRunRecord | undefined {
    const read = this.database.sqlite.transaction(() => {
      const row = this.getWorkflowRow(workflowId);
      return row ? this.hydrateWorkflow(row) : undefined;
    });
    return read.deferred();
  }

  require(workflowId: string): WorkflowRunRecord {
    const workflow = this.get(workflowId);
    if (!workflow) throw new WorkflowNotFoundError(workflowId);
    return workflow;
  }

  claimNode(claim: WorkflowNodeClaim): WorkflowNodeRecord | undefined {
    if (!claim.claimToken) throw new WorkflowValidationError("Node claim token must not be empty");
    const leaseMs = claim.leaseMs ?? DEFAULT_CLAIM_LEASE_MS;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > MAX_CLAIM_LEASE_MS) {
      throw new WorkflowValidationError(
        `Node claim lease must be between 1 and ${MAX_CLAIM_LEASE_MS} milliseconds`,
      );
    }
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const expiresAt = new Date(nowDate.getTime() + leaseMs).toISOString();
    const claimReady = this.database.sqlite.transaction(() => {
      const row = this.getNodeRow(claim.workflowId, claim.nodeKey);
      if (!row) return undefined;

      const workflow = this.getWorkflowRow(claim.workflowId);
      if (!workflow) throw new WorkflowNotFoundError(claim.workflowId);
      const workflowStatus = readWorkflowStatus(workflow.status);
      if (workflowStatus !== "queued" && workflowStatus !== "running") return undefined;

      if (row.status === "running" && row.claim_token === claim.claimToken) {
        this.database.sqlite
          .prepare(
            `update workflow_nodes
             set claim_expires_at = ?, updated_at = ?
             where id = ? and status = 'running' and claim_token = ?`,
          )
          .run(expiresAt, now, row.id, claim.claimToken);
        return this.getNodeRow(claim.workflowId, claim.nodeKey);
      }

      const reclaiming = row.status === "running";
      const updated = this.database.sqlite
        .prepare(
          `update workflow_nodes
           set status = 'running', claim_token = ?, claimed_at = ?, claim_expires_at = ?,
               attempt = attempt + 1, updated_at = ?
           where id = ?
             and (
               (status = 'ready' and claim_token is null)
               or (status = 'running' and claim_expires_at <= ?)
             )`,
        )
        .run(claim.claimToken, now, expiresAt, now, row.id, now);
      if (updated.changes !== 1) return undefined;

      if (workflowStatus === "queued") {
        this.database.sqlite
          .prepare(
            `update workflow_runs
             set status = 'running', started_at = coalesce(started_at, ?), updated_at = ?
             where id = ? and status = 'queued'`,
          )
          .run(now, now, claim.workflowId);
        this.insertEvent(claim.workflowId, "workflow.running", undefined, { status: "running" }, now);
      }
      this.insertEvent(
        claim.workflowId,
        reclaiming ? "node.reclaimed" : "node.running",
        row.id,
        { nodeKey: row.node_key, status: "running", claimToken: claim.claimToken },
        now,
      );
      return this.getNodeRow(claim.workflowId, claim.nodeKey);
    });

    const node = claimReady.immediate();
    return node ? rowToWorkflowNode(node) : undefined;
  }

  claimReadyNode(claim: WorkflowNodeClaim): WorkflowNodeRecord | undefined {
    return this.claimNode(claim);
  }

  transitionNode(transition: WorkflowNodeTransition): WorkflowNodeRecord {
    const now = new Date().toISOString();
    const update = this.database.sqlite.transaction(() => {
      const current = this.getNodeRow(transition.workflowId, transition.nodeKey);
      if (!current) {
        this.assertWorkflowExists(transition.workflowId);
        throw new WorkflowValidationError(`Unknown workflow node: ${transition.nodeKey}`);
      }
      const workflow = this.getWorkflowRow(transition.workflowId);
      if (!workflow) throw new WorkflowNotFoundError(transition.workflowId);
      const workflowStatus = readWorkflowStatus(workflow.status);
      if (TERMINAL_WORKFLOW_STATUSES.has(workflowStatus)) {
        throw new WorkflowValidationError(
          `Cannot transition node after workflow reached terminal status: ${workflowStatus}`,
        );
      }

      const currentStatus = readNodeStatus(current.status);
      if (!NODE_TRANSITIONS[currentStatus].has(transition.status)) {
        throw new WorkflowTransitionError("node", currentStatus, transition.status);
      }
      if (
        currentStatus === "running" &&
        (!transition.claimToken || transition.claimToken !== current.claim_token)
      ) {
        throw new WorkflowValidationError("Running node transition requires the active claim token");
      }

      const terminal = TERMINAL_NODE_STATUSES.has(transition.status);
      const resultJson = serializeOptionalJson(transition.result);
      const errorJson = serializeOptionalObject(transition.error);
      this.database.sqlite
        .prepare(
          `update workflow_nodes
           set status = ?, result_json = ?, error_json = ?, updated_at = ?, completed_at = ?,
               claim_expires_at = case when ? then null else claim_expires_at end
           where id = ? and status = ?`,
        )
        .run(
          transition.status,
          resultJson,
          errorJson,
          now,
          terminal ? now : null,
          terminal ? 1 : 0,
          current.id,
          currentStatus,
        );
      this.insertEvent(
        transition.workflowId,
        `node.${transition.status}`,
        current.id,
        transition.eventPayload ?? { nodeKey: current.node_key, status: transition.status },
        now,
      );
      return current.id;
    });

    return this.getNodeById(update.immediate())!;
  }

  transitionWorkflow(transition: WorkflowTransition): WorkflowRunRecord {
    const now = new Date().toISOString();
    const update = this.database.sqlite.transaction(() => {
      const current = this.getWorkflowRow(transition.workflowId);
      if (!current) throw new WorkflowNotFoundError(transition.workflowId);
      const currentStatus = readWorkflowStatus(current.status);
      if (!WORKFLOW_TRANSITIONS[currentStatus].has(transition.status)) {
        throw new WorkflowTransitionError("workflow", currentStatus, transition.status);
      }

      const terminal = TERMINAL_WORKFLOW_STATUSES.has(transition.status);
      if (transition.status === "succeeded") {
        const nonSuccessful = this.database.sqlite
          .prepare(
            `select node_key, status from workflow_nodes
             where workflow_run_id = ? and status not in ('succeeded', 'skipped')
             order by node_key
             limit 1`,
          )
          .get(transition.workflowId) as { node_key: string; status: string } | undefined;
        if (nonSuccessful) {
          throw new WorkflowValidationError(
            `Cannot succeed workflow while node ${nonSuccessful.node_key} is ${nonSuccessful.status}`,
          );
        }
      } else if (transition.status === "failed" || transition.status === "cancelled") {
        this.terminalizeOpenNodes(transition.workflowId, transition.status, now);
      }

      this.database.sqlite
        .prepare(
          `update workflow_runs
           set status = ?, result_json = ?, error_json = ?, updated_at = ?,
               started_at = case when ? = 'running' then coalesce(started_at, ?) else started_at end,
               completed_at = ?
           where id = ? and status = ?`,
        )
        .run(
          transition.status,
          serializeOptionalJson(transition.result),
          serializeOptionalObject(transition.error),
          now,
          transition.status,
          now,
          terminal ? now : null,
          transition.workflowId,
          currentStatus,
        );
      this.insertEvent(
        transition.workflowId,
        `workflow.${transition.status}`,
        undefined,
        transition.eventPayload ?? { status: transition.status },
        now,
      );
    });

    update.immediate();
    return this.require(transition.workflowId);
  }

  requestCancellation(workflowId: string): WorkflowRunRecord {
    const now = new Date().toISOString();
    const cancel = this.database.sqlite.transaction(() => {
      const current = this.getWorkflowRow(workflowId);
      if (!current) throw new WorkflowNotFoundError(workflowId);
      const status = readWorkflowStatus(current.status);
      if (TERMINAL_WORKFLOW_STATUSES.has(status) || status === "cancelling") return;

      this.database.sqlite
        .prepare(
          `update workflow_runs
           set status = 'cancelling', cancellation_requested_at = ?, updated_at = ?
           where id = ? and status = ?`,
        )
        .run(now, now, workflowId, status);
      this.insertEvent(
        workflowId,
        "workflow.cancellation_requested",
        undefined,
        { status: "cancelling" },
        now,
      );
    });

    cancel.immediate();
    return this.require(workflowId);
  }

  appendEvent(
    workflowId: string,
    type: string,
    payload: JsonObject,
    nodeId?: string,
  ): WorkflowEvent {
    if (!type.trim()) throw new WorkflowValidationError("Workflow event type must not be empty");
    const now = new Date().toISOString();
    const append = this.database.sqlite.transaction(() => {
      this.assertWorkflowExists(workflowId);
      if (nodeId) this.assertNodeBelongsToWorkflow(workflowId, nodeId);
      return this.insertEvent(workflowId, type, nodeId, payload, now);
    });
    const sequence = append.immediate();
    return this.readEvents(workflowId, { after: sequence - 1, limit: 1 }).events[0]!;
  }

  readEvents(workflowId: string, options: WorkflowEventReadOptions = {}): WorkflowEventPage {
    this.assertWorkflowExists(workflowId);
    const after = options.after ?? 0;
    const limit = options.limit ?? DEFAULT_EVENT_LIMIT;
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new WorkflowValidationError("Workflow event cursor must be a non-negative integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENT_LIMIT) {
      throw new WorkflowValidationError(`Workflow event limit must be between 1 and ${MAX_EVENT_LIMIT}`);
    }

    const rows = this.database.sqlite
      .prepare(
        `select * from workflow_events
         where workflow_run_id = ? and sequence > ?
         order by sequence asc
         limit ?`,
      )
      .all(workflowId, after, limit) as WorkflowEventRow[];
    const events = rows.map(rowToWorkflowEvent);
    return { events, nextCursor: events.at(-1)?.sequence ?? after };
  }

  close(): void {
    this.database.close();
  }

  private hydrateWorkflow(row: WorkflowRunRow): WorkflowRunRecord {
    const nodes = this.database.sqlite
      .prepare("select * from workflow_nodes where workflow_run_id = ? order by created_at, node_key")
      .all(row.id) as WorkflowNodeRow[];
    const edges = this.database.sqlite
      .prepare(
        `select e.workflow_run_id, e.from_node_id, e.to_node_id,
                source.node_key as from_key, target.node_key as to_key
         from workflow_edges e
         join workflow_nodes source on source.id = e.from_node_id
         join workflow_nodes target on target.id = e.to_node_id
         where e.workflow_run_id = ?
         order by source.node_key, target.node_key`,
      )
      .all(row.id) as WorkflowEdgeRow[];

    return {
      id: row.id,
      definitionVersion: readDefinitionVersion(row.definition_version),
      status: readWorkflowStatus(row.status),
      definition: parseJson<WorkflowDefinition>(row.definition_json),
      input: parseJson<JsonObject>(row.input_json),
      policy: parseJson<WorkflowPolicy>(row.policy_json),
      idempotencyKey: row.idempotency_key ?? undefined,
      requestHash: row.request_hash,
      result: parseOptionalJson(row.result_json),
      error: parseOptionalJson<JsonObject>(row.error_json),
      cancellationRequestedAt: row.cancellation_requested_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      nodes: nodes.map(rowToWorkflowNode),
      edges: edges.map(rowToWorkflowEdge),
    };
  }

  private getWorkflowRow(workflowId: string): WorkflowRunRow | undefined {
    return this.database.sqlite
      .prepare("select * from workflow_runs where id = ?")
      .get(workflowId) as WorkflowRunRow | undefined;
  }

  private getNodeRow(workflowId: string, nodeKey: string): WorkflowNodeRow | undefined {
    return this.database.sqlite
      .prepare("select * from workflow_nodes where workflow_run_id = ? and node_key = ?")
      .get(workflowId, nodeKey) as WorkflowNodeRow | undefined;
  }

  private getNodeById(nodeId: string): WorkflowNodeRecord | undefined {
    const row = this.database.sqlite
      .prepare("select * from workflow_nodes where id = ?")
      .get(nodeId) as WorkflowNodeRow | undefined;
    return row ? rowToWorkflowNode(row) : undefined;
  }

  private assertWorkflowExists(workflowId: string): void {
    if (!this.getWorkflowRow(workflowId)) throw new WorkflowNotFoundError(workflowId);
  }

  private assertNodeBelongsToWorkflow(workflowId: string, nodeId: string): void {
    const row = this.database.sqlite
      .prepare("select 1 from workflow_nodes where id = ? and workflow_run_id = ?")
      .get(nodeId, workflowId);
    if (!row) throw new WorkflowValidationError(`Node ${nodeId} does not belong to ${workflowId}`);
  }

  private terminalizeOpenNodes(
    workflowId: string,
    workflowStatus: "failed" | "cancelled",
    now: string,
  ): void {
    const rows = this.database.sqlite
      .prepare(
        `select * from workflow_nodes
         where workflow_run_id = ? and status in ('pending', 'ready', 'running')
         order by created_at, node_key`,
      )
      .all(workflowId) as WorkflowNodeRow[];
    const update = this.database.sqlite.prepare(
      `update workflow_nodes
       set status = ?, claim_expires_at = null, updated_at = ?, completed_at = ?
       where id = ? and status = ?`,
    );
    for (const row of rows) {
      const nodeStatus: WorkflowNodeStatus =
        workflowStatus === "failed" && row.status !== "running" ? "skipped" : "cancelled";
      const changed = update.run(nodeStatus, now, now, row.id, row.status);
      if (changed.changes !== 1) {
        throw new WorkflowValidationError(`Workflow node changed during terminal transition: ${row.node_key}`);
      }
      this.insertEvent(
        workflowId,
        `node.${nodeStatus}`,
        row.id,
        { nodeKey: row.node_key, status: nodeStatus },
        now,
      );
    }
  }

  private insertEvent(
    workflowId: string,
    type: string,
    nodeId: string | undefined,
    payload: JsonObject,
    now: string,
  ): number {
    const payloadJson = serializeEventPayload(payload);
    const sequenceRow = this.database.sqlite
      .prepare(
        `update workflow_runs
         set event_sequence = event_sequence + 1, updated_at = ?
         where id = ?
         returning event_sequence`,
      )
      .get(now, workflowId) as { event_sequence: number } | undefined;
    if (!sequenceRow) throw new WorkflowNotFoundError(workflowId);

    this.database.sqlite
      .prepare(
        `insert into workflow_events (
          workflow_run_id, sequence, event_type, node_id, payload_json, created_at
        ) values (?, ?, ?, ?, ?, ?)`,
      )
      .run(workflowId, sequenceRow.event_sequence, type, nodeId ?? null, payloadJson, now);
    return sequenceRow.event_sequence;
  }
}

function normalizeSubmission(request: SubmitWorkflowRequest): {
  definition: WorkflowDefinition;
  definitionJson: string;
  inputJson: string;
  policyJson: string;
  idempotencyKey?: string;
  requestHash: string;
} {
  const definition = normalizeDefinition(request.definition);
  const input = normalizeObject(request.input ?? {}, "Workflow input");
  const policy = normalizePolicy(request.policy ?? { version: WORKFLOW_POLICY_VERSION });
  const definitionJson = canonicalJson(definition);
  const inputJson = canonicalJson(input);
  const policyJson = canonicalJson(policy);
  const idempotencyKey = request.idempotencyKey?.trim();
  if (request.idempotencyKey !== undefined && !idempotencyKey) {
    throw new WorkflowValidationError("Idempotency key must not be empty");
  }
  const requestHash = createHash("sha256")
    .update(canonicalJson({ definition, input, policy }))
    .digest("hex");
  return { definition, definitionJson, inputJson, policyJson, idempotencyKey, requestHash };
}

function normalizeDefinition(definition: WorkflowDefinition): WorkflowDefinition {
  if (!isObject(definition) || definition.version !== WORKFLOW_DEFINITION_VERSION) {
    throw new WorkflowValidationError(
      `Unsupported workflow definition version; expected ${WORKFLOW_DEFINITION_VERSION}`,
    );
  }
  if (!Array.isArray(definition.nodes) || definition.nodes.length === 0) {
    throw new WorkflowValidationError("Workflow definition must contain at least one node");
  }
  if (definition.edges !== undefined && !Array.isArray(definition.edges)) {
    throw new WorkflowValidationError("Workflow definition edges must be an array");
  }

  const keys = new Set<string>();
  const nodes = definition.nodes.map((node, index): WorkflowNodeDefinitionV1 => {
    if (!isObject(node) || node.type !== "agent" || typeof node.key !== "string") {
      throw new WorkflowValidationError(`Workflow node at index ${index} is not a valid agent node`);
    }
    const key = node.key.trim();
    if (!key) throw new WorkflowValidationError(`Workflow node at index ${index} has an empty key`);
    if (keys.has(key)) throw new WorkflowValidationError(`Duplicate workflow node key: ${key}`);
    keys.add(key);
    return { key, type: "agent", config: normalizeObject(node.config ?? {}, `Node ${key} config`) };
  });

  const edgeKeys = new Set<string>();
  const edges = (definition.edges ?? []).map((edge, index) => {
    if (!isObject(edge) || typeof edge.from !== "string" || typeof edge.to !== "string") {
      throw new WorkflowValidationError(`Workflow edge at index ${index} is invalid`);
    }
    const from = edge.from.trim();
    const to = edge.to.trim();
    if (!keys.has(from)) throw new WorkflowValidationError(`Workflow edge references missing node: ${from}`);
    if (!keys.has(to)) throw new WorkflowValidationError(`Workflow edge references missing node: ${to}`);
    const edgeKey = canonicalJson([from, to]);
    if (edgeKeys.has(edgeKey)) {
      throw new WorkflowValidationError(`Duplicate workflow edge: ${from} -> ${to}`);
    }
    edgeKeys.add(edgeKey);
    return { from, to };
  });

  assertAcyclic(nodes.map((node) => node.key), edges);
  return parseJson<WorkflowDefinition>(canonicalJson({ version: WORKFLOW_DEFINITION_VERSION, nodes, edges }));
}

function normalizePolicy(policy: WorkflowPolicy): WorkflowPolicy {
  const normalized = normalizeObject(policy, "Workflow policy");
  if (normalized.version !== WORKFLOW_POLICY_VERSION) {
    throw new WorkflowValidationError(
      `Unsupported workflow policy version; expected ${WORKFLOW_POLICY_VERSION}`,
    );
  }
  return normalized as WorkflowPolicy;
}

function assertAcyclic(nodeKeys: string[], edges: Array<{ from: string; to: string }>): void {
  const incoming = new Map(nodeKeys.map((key) => [key, 0]));
  const outgoing = new Map(nodeKeys.map((key) => [key, [] as string[]]));
  for (const edge of edges) {
    incoming.set(edge.to, incoming.get(edge.to)! + 1);
    outgoing.get(edge.from)!.push(edge.to);
  }
  const ready = nodeKeys.filter((key) => incoming.get(key) === 0);
  let visited = 0;
  while (ready.length > 0) {
    const key = ready.pop()!;
    visited += 1;
    for (const target of outgoing.get(key)!) {
      const count = incoming.get(target)! - 1;
      incoming.set(target, count);
      if (count === 0) ready.push(target);
    }
  }
  if (visited !== nodeKeys.length) throw new WorkflowValidationError("Workflow definition contains a cycle");
}

function normalizeObject(value: unknown, label: string): JsonObject {
  if (!isObject(value)) throw new WorkflowValidationError(`${label} must be a JSON object`);
  try {
    return parseJson<JsonObject>(canonicalJson(value));
  } catch (error) {
    if (error instanceof WorkflowValidationError) throw error;
    throw new WorkflowValidationError(`${label} must contain only JSON values`);
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJsonValue(value));
}

function normalizeJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new WorkflowValidationError("JSON numbers must be finite");
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeJsonValue);
  if (isObject(value)) {
    const normalized = Object.create(null) as JsonObject;
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined) throw new WorkflowValidationError("JSON object values must not be undefined");
      normalized[key] = normalizeJsonValue(item);
    }
    return normalized;
  }
  throw new WorkflowValidationError("Value must contain only JSON data");
}

function serializeEventPayload(payload: JsonObject): string {
  if (!isObject(payload)) throw new WorkflowValidationError("Workflow event payload must be a JSON object");
  const serialized = canonicalJson(payload);
  if (Buffer.byteLength(serialized, "utf8") > MAX_EVENT_PAYLOAD_BYTES) {
    throw new WorkflowValidationError(
      `Workflow event payload exceeds ${MAX_EVENT_PAYLOAD_BYTES} bytes`,
    );
  }
  return serialized;
}

function serializeOptionalJson(value: JsonValue | undefined): string | null {
  return value === undefined ? null : canonicalJson(value);
}

function serializeOptionalObject(value: JsonObject | undefined): string | null {
  return value === undefined ? null : canonicalJson(normalizeObject(value, "Workflow error"));
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function parseOptionalJson<T = JsonValue>(value: string | null): T | undefined {
  return value === null ? undefined : parseJson<T>(value);
}

function rowToWorkflowNode(row: WorkflowNodeRow): WorkflowNodeRecord {
  return {
    id: row.id,
    workflowId: row.workflow_run_id,
    key: row.node_key,
    type: readNodeType(row.node_type),
    status: readNodeStatus(row.status),
    definition: parseJson<WorkflowNodeDefinitionV1>(row.definition_json),
    attempt: row.attempt,
    claimToken: row.claim_token ?? undefined,
    claimedAt: row.claimed_at ?? undefined,
    claimExpiresAt: row.claim_expires_at ?? undefined,
    result: parseOptionalJson(row.result_json),
    error: parseOptionalJson<JsonObject>(row.error_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function rowToWorkflowEdge(row: WorkflowEdgeRow): WorkflowEdgeRecord {
  return {
    workflowId: row.workflow_run_id,
    fromNodeId: row.from_node_id,
    toNodeId: row.to_node_id,
    from: row.from_key,
    to: row.to_key,
  };
}

function rowToWorkflowEvent(row: WorkflowEventRow): WorkflowEvent {
  return {
    workflowId: row.workflow_run_id,
    sequence: row.sequence,
    type: row.event_type,
    nodeId: row.node_id ?? undefined,
    payload: parseJson<JsonObject>(row.payload_json),
    createdAt: row.created_at,
  };
}

function readDefinitionVersion(version: number): typeof WORKFLOW_DEFINITION_VERSION {
  if (version !== WORKFLOW_DEFINITION_VERSION) {
    throw new WorkflowValidationError(`Unsupported stored workflow definition version: ${version}`);
  }
  return version;
}

function readWorkflowStatus(status: string): WorkflowStatus {
  if (
    status === "queued" ||
    status === "running" ||
    status === "cancelling" ||
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled"
  ) {
    return status;
  }
  throw new WorkflowValidationError(`Unsupported stored workflow status: ${status}`);
}

function readNodeStatus(status: string): WorkflowNodeStatus {
  if (
    status === "pending" ||
    status === "ready" ||
    status === "running" ||
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "skipped"
  ) {
    return status;
  }
  throw new WorkflowValidationError(`Unsupported stored workflow node status: ${status}`);
}

function readNodeType(type: string): WorkflowNodeDefinitionV1["type"] {
  if (type === "agent") return type;
  throw new WorkflowValidationError(`Unsupported stored workflow node type: ${type}`);
}

function createId(prefix: "wf_" | "wfn_"): string {
  return `${prefix}${randomUUID().replaceAll("-", "")}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
