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
  type WorkflowAttemptIdentity,
  type WorkflowNodeAttemptRecord,
  type WorkflowNodeClaim,
  type WorkflowNodeClaimResult,
  type WorkflowNodeDefinitionV1,
  type WorkflowNodeRecord,
  type WorkflowNodeStatus,
  type WorkflowNodeTransition,
  type WorkflowPolicy,
  type WorkflowRunRecord,
  type WorkflowStatus,
  type WorkflowSupervisorIdentity,
  type WorkflowSupervisorRecord,
  type WorkflowTransition,
  type WorkflowWorkspaceScope,
  type WorkflowWorktreeRecord,
} from "./types.js";

const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;
const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 1_000;
const DEFAULT_CLAIM_LEASE_MS = 5 * 60_000;
const MAX_CLAIM_LEASE_MS = 24 * 60 * 60_000;
const MAX_WORKFLOW_NODES = 64;
const MAX_WORKFLOW_EDGES = 256;
const MAX_RUN_CONCURRENCY = 16;
const SAFE_NODE_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

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
  workspace_id: string | null;
  workspace_root: string | null;
  max_concurrency: number;
  last_dispatched_at: string | null;
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
  next_eligible_at: string | null;
  supervisor_owner_token: string | null;
  supervisor_owner_epoch: number | null;
  heartbeat_at: string | null;
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

interface WorkflowSupervisorRow {
  owner_token: string | null;
  owner_epoch: number;
  owner_pid: number | null;
  status: WorkflowSupervisorRecord["status"];
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  wake_generation: number;
  started_at: string | null;
}

interface WorkflowWorktreeRow {
  workflow_run_id: string;
  node_key: string;
  attempt: number;
  path: string;
  source_root: string;
  base_sha: string;
  state: WorkflowWorktreeRecord["state"];
  retain_until: string | null;
  cleanup_error: string | null;
  created_at: string;
  updated_at: string;
}

interface WorkflowAttemptRow {
  node_id: string;
  workflow_run_id: string;
  node_key: string;
  attempt: number;
  claim_token: string;
  supervisor_owner_token: string;
  supervisor_owner_epoch: number;
  provider: string;
  phase: WorkflowNodeAttemptRecord["phase"];
  provider_session_id: string | null;
  heartbeat_at: string | null;
  cancellation_requested_at: string | null;
  terminal_status: WorkflowNodeAttemptRecord["terminalStatus"] | null;
  result_json: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
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
          if (!normalized.compatibleRequestHashes.has(existing.request_hash)) {
            throw new WorkflowIdempotencyConflictError(normalized.idempotencyKey);
          }
          return { workflowId: existing.id, created: false };
        }
      }

      this.database.sqlite
        .prepare(
          `insert into workflow_runs (
            id, definition_version, status, definition_json, input_json, policy_json,
            idempotency_key, request_hash, workspace_id, workspace_root, max_concurrency,
            created_at, updated_at
          ) values (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          workflowId,
          WORKFLOW_DEFINITION_VERSION,
          normalized.definitionJson,
          normalized.inputJson,
          normalized.policyJson,
          normalized.idempotencyKey ?? null,
          normalized.requestHash,
          normalized.workspace?.workspaceId ?? null,
          normalized.workspace?.workspaceRoot ?? null,
          normalized.maxConcurrency,
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

  getForWorkspace(workflowId: string, scope: WorkflowWorkspaceScope): WorkflowRunRecord | undefined {
    const workflow = this.get(workflowId);
    if (!workflow) return undefined;
    if (workflow.workspaceId !== scope.workspaceId || workflow.workspaceRoot !== scope.workspaceRoot) {
      return undefined;
    }
    return workflow;
  }

  requireForWorkspace(workflowId: string, scope: WorkflowWorkspaceScope): WorkflowRunRecord {
    const workflow = this.getForWorkspace(workflowId, scope);
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

  requestSupervisorWake(): number {
    const row = this.database.sqlite
      .prepare(
        `update workflow_supervisor set wake_generation = wake_generation + 1 where id = 1
         returning wake_generation`,
      )
      .get() as { wake_generation: number };
    return row.wake_generation;
  }

  getSupervisor(): WorkflowSupervisorRecord | undefined {
    const row = this.database.sqlite
      .prepare("select * from workflow_supervisor where id = 1")
      .get() as WorkflowSupervisorRow | undefined;
    return row?.owner_token ? rowToSupervisor(row) : undefined;
  }

  acquireSupervisor(input: {
    ownerToken: string;
    ownerPid: number;
    leaseMs: number;
  }): WorkflowSupervisorRecord | undefined {
    validateLease(input.leaseMs, "Supervisor");
    if (!input.ownerToken) throw new WorkflowValidationError("Supervisor owner token must not be empty");
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const expiresAt = new Date(nowDate.getTime() + input.leaseMs).toISOString();
    const acquire = this.database.sqlite.transaction(() => {
      const current = this.database.sqlite
        .prepare("select * from workflow_supervisor where id = 1")
        .get() as WorkflowSupervisorRow;
      if (current.owner_token && current.lease_expires_at && current.lease_expires_at > now) {
        return undefined;
      }
      const epoch = current.owner_epoch + 1;
      this.database.sqlite
        .prepare(
          `update workflow_supervisor
           set owner_token = ?, owner_epoch = ?, owner_pid = ?, status = 'running',
               lease_expires_at = ?, heartbeat_at = ?, started_at = ?, last_error = null
           where id = 1`,
        )
        .run(input.ownerToken, epoch, input.ownerPid, expiresAt, now, now);
      return this.getSupervisor();
    });
    return acquire.immediate();
  }

  heartbeatSupervisor(identity: WorkflowSupervisorIdentity, leaseMs: number): boolean {
    validateLease(leaseMs, "Supervisor");
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const expiresAt = new Date(nowDate.getTime() + leaseMs).toISOString();
    const result = this.database.sqlite
      .prepare(
        `update workflow_supervisor set heartbeat_at = ?, lease_expires_at = ?, status = 'running'
         where id = 1 and owner_token = ? and owner_epoch = ? and lease_expires_at > ?`,
      )
      .run(now, expiresAt, identity.ownerToken, identity.ownerEpoch, now);
    return result.changes === 1;
  }

  releaseSupervisor(identity: WorkflowSupervisorIdentity, expectedWakeGeneration?: number): boolean {
    const now = new Date().toISOString();
    const wakeFence = expectedWakeGeneration === undefined ? "" : " and wake_generation = ?";
    const result = this.database.sqlite
      .prepare(
        `update workflow_supervisor
         set owner_token = null, owner_pid = null, status = 'stopped', lease_expires_at = null,
             heartbeat_at = ?, started_at = null
         where id = 1 and owner_token = ? and owner_epoch = ?${wakeFence}`,
      )
      .run(
        now,
        identity.ownerToken,
        identity.ownerEpoch,
        ...(expectedWakeGeneration === undefined ? [] : [expectedWakeGeneration]),
      );
    return result.changes === 1;
  }

  claimNextAgentNode(input: {
    supervisor: WorkflowSupervisorIdentity;
    claimToken: string;
    leaseMs: number;
  }): WorkflowNodeClaimResult | undefined {
    validateLease(input.leaseMs, "Node claim");
    if (!input.claimToken) throw new WorkflowValidationError("Node claim token must not be empty");
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const expiresAt = new Date(nowDate.getTime() + input.leaseMs).toISOString();
    const claim = this.database.sqlite.transaction(() => {
      this.assertActiveSupervisor(input.supervisor, now);
      const candidate = this.database.sqlite
        .prepare(
          `select n.* from workflow_nodes n
           join workflow_runs r on r.id = n.workflow_run_id
           where n.status = 'ready' and n.claim_token is null
             and (n.next_eligible_at is null or n.next_eligible_at <= ?)
             and r.status in ('queued', 'running') and r.cancellation_requested_at is null
             and (
               select count(*) from workflow_nodes active
               where active.workflow_run_id = r.id and active.status = 'running'
             ) < r.max_concurrency
           order by case when r.last_dispatched_at is null then 0 else 1 end,
                    r.last_dispatched_at,
                    (select count(*) from workflow_node_attempts attempts
                     where attempts.workflow_run_id = r.id),
                    r.created_at, n.created_at, n.node_key limit 1`,
        )
        .get(now) as WorkflowNodeRow | undefined;
      if (!candidate) return undefined;
      const updated = this.database.sqlite
        .prepare(
          `update workflow_nodes
           set status = 'running', claim_token = ?, claimed_at = ?, claim_expires_at = ?,
               next_eligible_at = null, attempt = attempt + 1,
               supervisor_owner_token = ?, supervisor_owner_epoch = ?,
               heartbeat_at = ?, updated_at = ?
           where id = ? and status = 'ready' and claim_token is null`,
        )
        .run(
          input.claimToken,
          now,
          expiresAt,
          input.supervisor.ownerToken,
          input.supervisor.ownerEpoch,
          now,
          now,
          candidate.id,
        );
      if (updated.changes !== 1) return undefined;
      const node = this.database.sqlite
        .prepare("select * from workflow_nodes where id = ?")
        .get(candidate.id) as WorkflowNodeRow;
      const definition = parseJson<WorkflowNodeDefinitionV1>(node.definition_json);
      const provider = typeof definition.config?.provider === "string" ? definition.config.provider : "unknown";
      this.database.sqlite
        .prepare(
          `insert into workflow_node_attempts (
             node_id, workflow_run_id, node_key, attempt, claim_token,
             supervisor_owner_token, supervisor_owner_epoch, provider, phase,
             heartbeat_at, created_at, updated_at
           ) values (?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, ?, ?)`,
        )
        .run(
          node.id,
          node.workflow_run_id,
          node.node_key,
          node.attempt,
          input.claimToken,
          input.supervisor.ownerToken,
          input.supervisor.ownerEpoch,
          provider,
          now,
          now,
          now,
        );
      this.database.sqlite
        .prepare("update workflow_runs set last_dispatched_at = ?, updated_at = ? where id = ?")
        .run(now, now, node.workflow_run_id);
      const workflow = this.getWorkflowRow(node.workflow_run_id)!;
      if (workflow.status === "queued") {
        this.database.sqlite
          .prepare(
            `update workflow_runs set status = 'running', started_at = coalesce(started_at, ?), updated_at = ?
             where id = ? and status = 'queued'`,
          )
          .run(now, now, node.workflow_run_id);
        this.insertEvent(node.workflow_run_id, "workflow.running", undefined, { status: "running" }, now);
      }
      this.insertEvent(
        node.workflow_run_id,
        "node.running",
        node.id,
        { nodeKey: node.node_key, status: "running", attempt: node.attempt },
        now,
      );
      return {
        workflow: this.hydrateWorkflow(this.getWorkflowRow(node.workflow_run_id)!),
        node: rowToWorkflowNode(node),
        attempt: rowToAttempt(this.getAttemptRow(node.id, node.attempt)!),
      };
    });
    return claim.immediate();
  }

  heartbeatNode(input: WorkflowAttemptIdentity & { leaseMs: number }): WorkflowNodeRecord | undefined {
    validateLease(input.leaseMs, "Node claim");
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const expiresAt = new Date(nowDate.getTime() + input.leaseMs).toISOString();
    const update = this.database.sqlite.transaction(() => {
      const result = this.database.sqlite
        .prepare(
          `update workflow_nodes set heartbeat_at = ?, claim_expires_at = ?, updated_at = ?
           where workflow_run_id = ? and node_key = ? and status = 'running'
             and attempt = ? and claim_token = ? and claim_expires_at > ?`,
        )
        .run(now, expiresAt, now, input.workflowId, input.nodeKey, input.attempt, input.claimToken, now);
      if (result.changes !== 1) return undefined;
      this.database.sqlite
        .prepare(
          `update workflow_node_attempts set heartbeat_at = ?, updated_at = ?
           where workflow_run_id = ? and node_key = ? and attempt = ? and claim_token = ?
             and phase != 'terminal'`,
        )
        .run(now, now, input.workflowId, input.nodeKey, input.attempt, input.claimToken);
      return this.getNodeRow(input.workflowId, input.nodeKey);
    });
    const row = update.immediate();
    return row ? rowToWorkflowNode(row) : undefined;
  }

  markNodeDispatching(identity: WorkflowAttemptIdentity): WorkflowNodeAttemptRecord | undefined {
    return this.updateAttemptPhase(identity, "dispatching");
  }

  markNodeRunning(identity: WorkflowAttemptIdentity): WorkflowNodeAttemptRecord | undefined {
    return this.updateAttemptPhase(identity, "running");
  }

  markNodeCancelling(identity: WorkflowAttemptIdentity): WorkflowNodeAttemptRecord | undefined {
    const now = new Date().toISOString();
    const update = this.database.sqlite.transaction(() => {
      const attempt = this.getActiveAttempt(identity, now);
      if (!attempt) return undefined;
      const result = this.database.sqlite
        .prepare(
          `update workflow_node_attempts set phase = 'cancelling', cancellation_requested_at = ?, updated_at = ?
           where node_id = ? and attempt = ? and claim_token = ? and phase != 'terminal'`,
        )
        .run(now, now, attempt.nodeId, attempt.attempt, identity.claimToken);
      return result.changes === 1 ? this.getAttempt(identity) : undefined;
    });
    return update.immediate();
  }

  recordNodeProviderSession(
    identity: WorkflowAttemptIdentity,
    providerSessionId: string,
  ): WorkflowNodeAttemptRecord | undefined {
    const now = new Date().toISOString();
    const update = this.database.sqlite.transaction(() => {
      const attempt = this.getActiveAttempt(identity, now);
      if (!attempt) return undefined;
      const result = this.database.sqlite
        .prepare(
          `update workflow_node_attempts set provider_session_id = ?, updated_at = ?
           where node_id = ? and attempt = ? and claim_token = ? and phase != 'terminal'`,
        )
        .run(providerSessionId, now, attempt.nodeId, attempt.attempt, identity.claimToken);
      return result.changes === 1 ? this.getAttempt(identity) : undefined;
    });
    return update.immediate();
  }

  appendNodeExecutionEvent(input: {
    identity: WorkflowAttemptIdentity;
    sourceSequence: number;
    type: string;
    payload: JsonObject;
  }): { event: WorkflowEvent; created: boolean } {
    const now = new Date().toISOString();
    const append = this.database.sqlite.transaction(() => {
      const attempt = this.getActiveAttempt(input.identity, now);
      if (!attempt) return undefined;
      const existing = this.database.sqlite
        .prepare(
          `select workflow_sequence from workflow_provider_events
           where node_id = ? and attempt = ? and source_sequence = ?`,
        )
        .get(attempt.nodeId, attempt.attempt, input.sourceSequence) as
        | { workflow_sequence: number }
        | undefined;
      if (existing) return { sequence: existing.workflow_sequence, created: false };
      const sequence = this.insertEvent(
        input.identity.workflowId,
        input.type,
        attempt.nodeId,
        input.payload,
        now,
      );
      this.database.sqlite
        .prepare(
          `insert into workflow_provider_events (
             node_id, attempt, source_sequence, workflow_sequence, event_type, payload_json, created_at
           ) values (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          attempt.nodeId,
          attempt.attempt,
          input.sourceSequence,
          sequence,
          input.type,
          serializeEventPayload(input.payload),
          now,
        );
      return { sequence, created: true };
    });
    const saved = append.immediate();
    if (!saved) throw new WorkflowValidationError("Workflow attempt is no longer active");
    return {
      event: this.readEvents(input.identity.workflowId, { after: saved.sequence - 1, limit: 1 }).events[0]!,
      created: saved.created,
    };
  }

  completeAgentNode(input: WorkflowAttemptIdentity & {
    status: "succeeded" | "failed" | "cancelled";
    result?: JsonValue;
    error?: JsonObject;
  }): WorkflowRunRecord | undefined {
    const now = new Date().toISOString();
    const complete = this.database.sqlite.transaction(() => {
      const node = this.getNodeRow(input.workflowId, input.nodeKey);
      if (
        !node ||
        node.status !== "running" ||
        node.attempt !== input.attempt ||
        node.claim_token !== input.claimToken ||
        !node.claim_expires_at ||
        node.claim_expires_at <= now ||
        !node.supervisor_owner_token ||
        node.supervisor_owner_epoch === null
      ) return false;
      const activeSupervisor = this.database.sqlite
        .prepare(
          `select 1 from workflow_supervisor
           where id = 1 and owner_token = ? and owner_epoch = ? and lease_expires_at > ?`,
        )
        .get(node.supervisor_owner_token, node.supervisor_owner_epoch, now);
      if (!activeSupervisor) return false;

      const workflow = this.getWorkflowRow(input.workflowId);
      if (!workflow || (workflow.status !== "running" && workflow.status !== "cancelling")) return false;
      const status = workflow.status === "cancelling" ? "cancelled" : input.status;
      const resultJson = serializeOptionalJson(input.result);
      const errorJson = serializeOptionalObject(input.error);
      const retryAt = status === "failed"
        ? retryEligibleAt(parseJson<WorkflowNodeDefinitionV1>(node.definition_json), input.attempt, input.error, now)
        : undefined;
      if (retryAt) {
        const nodeUpdate = this.database.sqlite
          .prepare(
            `update workflow_nodes
             set status = 'ready', result_json = null, error_json = ?, claim_token = null,
                 claimed_at = null, claim_expires_at = null, next_eligible_at = ?,
                 supervisor_owner_token = null, supervisor_owner_epoch = null,
                 heartbeat_at = ?, updated_at = ?, completed_at = null
             where id = ? and status = 'running' and attempt = ? and claim_token = ?`,
          )
          .run(errorJson, retryAt, now, now, node.id, input.attempt, input.claimToken);
        if (nodeUpdate.changes !== 1) return false;
        this.database.sqlite
          .prepare(
            `update workflow_node_attempts
             set phase = 'terminal', terminal_status = 'failed', error_json = ?,
                 heartbeat_at = ?, updated_at = ?, completed_at = ?
             where node_id = ? and attempt = ? and claim_token = ? and phase != 'terminal'`,
          )
          .run(errorJson, now, now, now, node.id, input.attempt, input.claimToken);
        this.insertEvent(
          input.workflowId,
          "node.retry_scheduled",
          node.id,
          { nodeKey: node.node_key, attempt: input.attempt, nextEligibleAt: retryAt },
          now,
        );
        return true;
      }
      const nodeUpdate = this.database.sqlite
        .prepare(
          `update workflow_nodes
           set status = ?, result_json = ?, error_json = ?, claim_token = null,
               claimed_at = null, claim_expires_at = null, next_eligible_at = null,
               supervisor_owner_token = null, supervisor_owner_epoch = null,
               heartbeat_at = ?, updated_at = ?, completed_at = ?
           where id = ? and status = 'running' and attempt = ? and claim_token = ?`,
        )
        .run(status, resultJson, errorJson, now, now, now, node.id, input.attempt, input.claimToken);
      if (nodeUpdate.changes !== 1) return false;
      const attemptUpdate = this.database.sqlite
        .prepare(
          `update workflow_node_attempts
           set phase = 'terminal', terminal_status = ?, result_json = ?, error_json = ?,
               heartbeat_at = ?, updated_at = ?, completed_at = ?
           where node_id = ? and attempt = ? and claim_token = ? and phase != 'terminal'`,
        )
        .run(status, resultJson, errorJson, now, now, now, node.id, input.attempt, input.claimToken);
      if (attemptUpdate.changes !== 1) {
        throw new WorkflowValidationError(`Workflow attempt changed during completion: ${node.node_key}`);
      }
      this.insertEvent(
        input.workflowId,
        `node.${status}`,
        node.id,
        { nodeKey: node.node_key, status, attempt: input.attempt },
        now,
      );

      let workflowStatus: "succeeded" | "failed" | "cancelled" | undefined;
      if (status === "succeeded") {
        this.promoteReadyNodes(input.workflowId, node.id, now);
        const remaining = this.database.sqlite
          .prepare(
            `select count(*) from workflow_nodes
             where workflow_run_id = ? and status not in ('succeeded', 'skipped')`,
          )
          .pluck()
          .get(input.workflowId) as number;
        if (remaining === 0) workflowStatus = "succeeded";
      } else {
        workflowStatus = status;
        this.terminalizeOpenNodes(input.workflowId, status, now);
      }
      if (!workflowStatus) return true;

      const workflowUpdate = this.database.sqlite
        .prepare(
          `update workflow_runs set status = ?, result_json = ?, error_json = ?, updated_at = ?, completed_at = ?
           where id = ? and status in ('running', 'cancelling')`,
        )
        .run(workflowStatus, resultJson, errorJson, now, now, input.workflowId);
      if (workflowUpdate.changes !== 1) {
        throw new WorkflowValidationError(`Workflow changed during node completion: ${input.workflowId}`);
      }
      this.insertEvent(
        input.workflowId,
        `workflow.${workflowStatus}`,
        undefined,
        { status: workflowStatus },
        now,
      );
      return true;
    });
    return complete.immediate() ? this.require(input.workflowId) : undefined;
  }

  reconcileExpiredClaims(): number {
    const now = new Date().toISOString();
    const reconcile = this.database.sqlite.transaction(() => {
      const expired = this.database.sqlite
        .prepare(
          `select * from workflow_nodes
           where status = 'running' and claim_expires_at is not null and claim_expires_at <= ?
           order by created_at`,
        )
        .all(now) as WorkflowNodeRow[];
      let reconciled = 0;
      for (const node of expired) {
        const error = { code: "worker_lost", message: "Workflow worker lease expired before completion." };
        const nodeUpdate = this.database.sqlite
          .prepare(
            `update workflow_nodes set status = 'failed', error_json = ?, claim_expires_at = null,
               updated_at = ?, completed_at = ? where id = ? and status = 'running'`,
          )
          .run(canonicalJson(error), now, now, node.id);
        if (nodeUpdate.changes !== 1) continue;
        reconciled += 1;
        this.database.sqlite
          .prepare(
            `update workflow_node_attempts
             set phase = 'terminal', terminal_status = 'failed', error_json = ?, updated_at = ?, completed_at = ?
             where node_id = ? and attempt = ? and phase != 'terminal'`,
          )
          .run(canonicalJson(error), now, now, node.id, node.attempt);
        this.insertEvent(
          node.workflow_run_id,
          "node.failed",
          node.id,
          { nodeKey: node.node_key, status: "failed", code: "worker_lost" },
          now,
        );
        this.terminalizeOpenNodes(node.workflow_run_id, "failed", now);
        const changed = this.database.sqlite
          .prepare(
            `update workflow_runs set status = 'failed', error_json = ?, updated_at = ?, completed_at = ?
             where id = ? and status in ('running', 'cancelling')`,
          )
          .run(canonicalJson(error), now, now, node.workflow_run_id);
        if (changed.changes === 1) {
          this.insertEvent(
            node.workflow_run_id,
            "workflow.failed",
            undefined,
            { status: "failed", code: "worker_lost" },
            now,
          );
        }
      }
      return reconciled;
    });
    return reconcile.immediate();
  }

  convergeCancellations(): number {
    const now = new Date().toISOString();
    const converge = this.database.sqlite.transaction(() => {
      const runs = this.database.sqlite
        .prepare("select id from workflow_runs where status = 'cancelling'")
        .all() as Array<{ id: string }>;
      let completed = 0;
      for (const run of runs) {
        const pending = this.database.sqlite
          .prepare(
            `select * from workflow_nodes where workflow_run_id = ? and status in ('pending', 'ready')`,
          )
          .all(run.id) as WorkflowNodeRow[];
        for (const node of pending) {
          this.database.sqlite
            .prepare(
              `update workflow_nodes set status = 'cancelled', updated_at = ?, completed_at = ?
               where id = ? and status in ('pending', 'ready')`,
            )
            .run(now, now, node.id);
          this.insertEvent(run.id, "node.cancelled", node.id, { nodeKey: node.node_key, status: "cancelled" }, now);
        }
        const open = this.database.sqlite
          .prepare(
            `select count(*) from workflow_nodes
             where workflow_run_id = ? and status in ('pending', 'ready', 'running')`,
          )
          .pluck()
          .get(run.id) as number;
        if (open !== 0) continue;
        this.database.sqlite
          .prepare(
            `update workflow_runs set status = 'cancelled', updated_at = ?, completed_at = ?
             where id = ? and status = 'cancelling'`,
          )
          .run(now, now, run.id);
        this.insertEvent(run.id, "workflow.cancelled", undefined, { status: "cancelled" }, now);
        completed += 1;
      }
      return completed;
    });
    return converge.immediate();
  }

  isCancellationRequested(workflowId: string): boolean {
    const row = this.database.sqlite
      .prepare("select status from workflow_runs where id = ?")
      .get(workflowId) as { status: string } | undefined;
    return row?.status === "cancelling";
  }

  hasPendingWork(): boolean {
    return Boolean(
      this.database.sqlite
        .prepare("select 1 from workflow_runs where status in ('queued', 'running', 'cancelling') limit 1")
        .get(),
    );
  }

  recordWorktree(input: Omit<WorkflowWorktreeRecord, "state" | "createdAt" | "updatedAt">): WorkflowWorktreeRecord {
    const now = new Date().toISOString();
    this.database.sqlite
      .prepare(
        `insert into workflow_worktrees (
           workflow_run_id, node_key, attempt, path, source_root, base_sha, state,
           retain_until, created_at, updated_at
         ) values (?, ?, ?, ?, ?, ?, 'allocated', ?, ?, ?)
         on conflict(workflow_run_id, node_key, attempt) do nothing`,
      )
      .run(
        input.workflowId,
        input.nodeKey,
        input.attempt,
        input.path,
        input.sourceRoot,
        input.baseSha,
        input.retainUntil ?? null,
        now,
        now,
      );
    return this.requireWorktree(input.workflowId, input.nodeKey, input.attempt);
  }

  getWorktree(workflowId: string, nodeKey: string, attempt: number): WorkflowWorktreeRecord | undefined {
    const row = this.database.sqlite
      .prepare(
        `select * from workflow_worktrees
         where workflow_run_id = ? and node_key = ? and attempt = ?`,
      )
      .get(workflowId, nodeKey, attempt) as WorkflowWorktreeRow | undefined;
    return row ? rowToWorktree(row) : undefined;
  }

  listExpiredWorktrees(now = new Date().toISOString()): WorkflowWorktreeRecord[] {
    const rows = this.database.sqlite
      .prepare(
        `select * from workflow_worktrees
         where state in ('preserved', 'cleanup_failed')
           and retain_until is not null and retain_until <= ?
         order by retain_until, created_at`,
      )
      .all(now) as WorkflowWorktreeRow[];
    return rows.map(rowToWorktree);
  }

  updateWorktreeState(
    workflowId: string,
    nodeKey: string,
    attempt: number,
    state: WorkflowWorktreeRecord["state"],
    cleanupError?: string,
  ): WorkflowWorktreeRecord {
    const now = new Date().toISOString();
    const changed = this.database.sqlite
      .prepare(
        `update workflow_worktrees set state = ?, cleanup_error = ?, updated_at = ?
         where workflow_run_id = ? and node_key = ? and attempt = ?`,
      )
      .run(state, cleanupError ?? null, now, workflowId, nodeKey, attempt);
    if (changed.changes !== 1) throw new WorkflowValidationError("Unknown workflow worktree allocation");
    return this.requireWorktree(workflowId, nodeKey, attempt);
  }

  close(): void {
    this.database.close();
  }

  private requireWorktree(workflowId: string, nodeKey: string, attempt: number): WorkflowWorktreeRecord {
    const record = this.getWorktree(workflowId, nodeKey, attempt);
    if (!record) throw new WorkflowValidationError("Unknown workflow worktree allocation");
    return record;
  }

  private assertActiveSupervisor(identity: WorkflowSupervisorIdentity, now: string): void {
    const row = this.database.sqlite
      .prepare(
        `select 1 from workflow_supervisor
         where id = 1 and owner_token = ? and owner_epoch = ? and lease_expires_at > ?`,
      )
      .get(identity.ownerToken, identity.ownerEpoch, now);
    if (!row) throw new WorkflowValidationError("Workflow supervisor lease is not active");
  }

  private getAttemptRow(nodeId: string, attempt: number): WorkflowAttemptRow | undefined {
    return this.database.sqlite
      .prepare("select * from workflow_node_attempts where node_id = ? and attempt = ?")
      .get(nodeId, attempt) as WorkflowAttemptRow | undefined;
  }

  private getAttempt(identity: WorkflowAttemptIdentity): WorkflowNodeAttemptRecord | undefined {
    const row = this.database.sqlite
      .prepare(
        `select * from workflow_node_attempts
         where workflow_run_id = ? and node_key = ? and attempt = ? and claim_token = ?`,
      )
      .get(identity.workflowId, identity.nodeKey, identity.attempt, identity.claimToken) as
      | WorkflowAttemptRow
      | undefined;
    return row ? rowToAttempt(row) : undefined;
  }

  private getActiveAttempt(
    identity: WorkflowAttemptIdentity,
    now: string,
  ): WorkflowNodeAttemptRecord | undefined {
    const row = this.database.sqlite
      .prepare(
        `select attempts.* from workflow_node_attempts attempts
         join workflow_nodes nodes on nodes.id = attempts.node_id
         join workflow_supervisor supervisor on supervisor.id = 1
         where attempts.workflow_run_id = ? and attempts.node_key = ?
           and attempts.attempt = ? and attempts.claim_token = ?
           and attempts.phase != 'terminal'
           and nodes.status = 'running' and nodes.attempt = attempts.attempt
           and nodes.claim_token = attempts.claim_token and nodes.claim_expires_at > ?
           and nodes.supervisor_owner_token = attempts.supervisor_owner_token
           and nodes.supervisor_owner_epoch = attempts.supervisor_owner_epoch
           and supervisor.owner_token = attempts.supervisor_owner_token
           and supervisor.owner_epoch = attempts.supervisor_owner_epoch
           and supervisor.lease_expires_at > ?`,
      )
      .get(
        identity.workflowId,
        identity.nodeKey,
        identity.attempt,
        identity.claimToken,
        now,
        now,
      ) as WorkflowAttemptRow | undefined;
    return row ? rowToAttempt(row) : undefined;
  }

  private updateAttemptPhase(
    identity: WorkflowAttemptIdentity,
    phase: "dispatching" | "running",
  ): WorkflowNodeAttemptRecord | undefined {
    const now = new Date().toISOString();
    const update = this.database.sqlite.transaction(() => {
      const attempt = this.getActiveAttempt(identity, now);
      if (!attempt) return undefined;
      const result = this.database.sqlite
        .prepare(
          `update workflow_node_attempts set phase = ?, updated_at = ?
           where node_id = ? and attempt = ? and claim_token = ? and phase != 'terminal'`,
        )
        .run(phase, now, attempt.nodeId, attempt.attempt, identity.claimToken);
      return result.changes === 1 ? this.getAttempt(identity) : undefined;
    });
    return update.immediate();
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
      workspaceId: row.workspace_id ?? undefined,
      workspaceRoot: row.workspace_root ?? undefined,
      maxConcurrency: row.max_concurrency,
      lastDispatchedAt: row.last_dispatched_at ?? undefined,
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

  private promoteReadyNodes(workflowId: string, completedNodeId: string, now: string): void {
    const rows = this.database.sqlite
      .prepare(
        `select target.* from workflow_edges edge
         join workflow_nodes target
           on target.workflow_run_id = edge.workflow_run_id and target.id = edge.to_node_id
         where edge.workflow_run_id = ? and edge.from_node_id = ? and target.status = 'pending'
           and not exists (
             select 1 from workflow_edges incoming
             join workflow_nodes source
               on source.workflow_run_id = incoming.workflow_run_id and source.id = incoming.from_node_id
             where incoming.workflow_run_id = edge.workflow_run_id
               and incoming.to_node_id = edge.to_node_id
               and source.status not in ('succeeded', 'skipped')
           )
         order by target.created_at, target.node_key`,
      )
      .all(workflowId, completedNodeId) as WorkflowNodeRow[];
    const update = this.database.sqlite.prepare(
      `update workflow_nodes set status = 'ready', updated_at = ? where id = ? and status = 'pending'`,
    );
    for (const row of rows) {
      const changed = update.run(now, row.id);
      if (changed.changes !== 1) {
        throw new WorkflowValidationError(`Workflow node changed during dependency promotion: ${row.node_key}`);
      }
      this.insertEvent(workflowId, "node.ready", row.id, { nodeKey: row.node_key, status: "ready" }, now);
    }
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
      if (row.status === "running") {
        this.database.sqlite
          .prepare(
            `update workflow_node_attempts
             set phase = 'terminal', terminal_status = ?, updated_at = ?, completed_at = ?
             where node_id = ? and attempt = ? and phase != 'terminal'`,
          )
          .run(nodeStatus, now, now, row.id, row.attempt);
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
  workspace?: WorkflowWorkspaceScope;
  maxConcurrency: number;
  requestHash: string;
  compatibleRequestHashes: ReadonlySet<string>;
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
  const workspace = request.workspace
    ? {
        workspaceId: requireNonEmptyString(request.workspace.workspaceId, "Workspace id"),
        workspaceRoot: requireNonEmptyString(request.workspace.workspaceRoot, "Workspace root"),
      }
    : undefined;
  const maxConcurrency = readBoundedInteger(policy.maxConcurrency, 1, MAX_RUN_CONCURRENCY, "Workflow maxConcurrency");
  const requestHash = hashWorkflowRequest({ definition, input, policy, workspace: workspace ?? null });
  const compatibleRequestHashes = new Set([requestHash]);
  const legacyRequest = legacySingleAgentRequest(definition, input, policy, workspace);
  if (legacyRequest) compatibleRequestHashes.add(hashWorkflowRequest(legacyRequest));
  return {
    definition,
    definitionJson,
    inputJson,
    policyJson,
    idempotencyKey,
    workspace,
    maxConcurrency,
    requestHash,
    compatibleRequestHashes,
  };
}

function hashWorkflowRequest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function legacySingleAgentRequest(
  definition: WorkflowDefinition,
  input: JsonObject,
  policy: WorkflowPolicy,
  workspace: WorkflowWorkspaceScope | undefined,
): JsonObject | undefined {
  if (
    input.kind !== "single" ||
    definition.nodes.length !== 1 ||
    (definition.edges?.length ?? 0) !== 0 ||
    policy.maxConcurrency !== 1 ||
    typeof policy.access !== "string"
  ) return undefined;
  const node = definition.nodes[0]!;
  const config = { ...(node.config ?? {}) } as JsonObject;
  const prompt = config.prompt;
  const retry = config.retry;
  if (
    typeof prompt !== "string" ||
    !isObject(retry) ||
    retry.maxAttempts !== 1 ||
    !Array.isArray(retry.retryOn) ||
    retry.retryOn.length !== 0 ||
    retry.backoffMs !== 0
  ) return undefined;
  delete config.worktreeRoot;
  delete config.baseSha;
  delete config.retry;
  const legacyDefinition: WorkflowDefinition = {
    version: WORKFLOW_DEFINITION_VERSION,
    nodes: [{ key: node.key, type: "agent", config }],
    edges: [],
  };
  return {
    definition: legacyDefinition as unknown as JsonObject,
    input: { prompt },
    policy: { version: WORKFLOW_POLICY_VERSION, access: policy.access },
    workspace: workspace ? { ...workspace } : null,
  };
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
  if (definition.nodes.length > MAX_WORKFLOW_NODES) {
    throw new WorkflowValidationError(`Workflow definition exceeds ${MAX_WORKFLOW_NODES} nodes`);
  }
  if (definition.edges !== undefined && !Array.isArray(definition.edges)) {
    throw new WorkflowValidationError("Workflow definition edges must be an array");
  }
  if ((definition.edges?.length ?? 0) > MAX_WORKFLOW_EDGES) {
    throw new WorkflowValidationError(`Workflow definition exceeds ${MAX_WORKFLOW_EDGES} edges`);
  }

  const keys = new Set<string>();
  const nodes = definition.nodes.map((node, index): WorkflowNodeDefinitionV1 => {
    if (!isObject(node) || node.type !== "agent" || typeof node.key !== "string") {
      throw new WorkflowValidationError(`Workflow node at index ${index} is not a valid agent node`);
    }
    const key = node.key.trim();
    if (!key) throw new WorkflowValidationError(`Workflow node at index ${index} has an empty key`);
    if (!SAFE_NODE_KEY.test(key)) {
      throw new WorkflowValidationError(`Workflow node key is unsafe: ${key}`);
    }
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
    nextEligibleAt: row.next_eligible_at ?? undefined,
    result: parseOptionalJson(row.result_json),
    error: parseOptionalJson<JsonObject>(row.error_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function rowToWorktree(row: WorkflowWorktreeRow): WorkflowWorktreeRecord {
  return {
    workflowId: row.workflow_run_id,
    nodeKey: row.node_key,
    attempt: row.attempt,
    path: row.path,
    sourceRoot: row.source_root,
    baseSha: row.base_sha,
    state: row.state,
    retainUntil: row.retain_until ?? undefined,
    cleanupError: row.cleanup_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToAttempt(row: WorkflowAttemptRow): WorkflowNodeAttemptRecord {
  return {
    nodeId: row.node_id,
    workflowId: row.workflow_run_id,
    nodeKey: row.node_key,
    attempt: row.attempt,
    claimToken: row.claim_token,
    supervisorOwnerToken: row.supervisor_owner_token,
    supervisorOwnerEpoch: row.supervisor_owner_epoch,
    provider: row.provider,
    phase: row.phase,
    providerSessionId: row.provider_session_id ?? undefined,
    heartbeatAt: row.heartbeat_at ?? undefined,
    cancellationRequestedAt: row.cancellation_requested_at ?? undefined,
    terminalStatus: row.terminal_status ?? undefined,
    result: parseOptionalJson(row.result_json),
    error: parseOptionalJson<JsonObject>(row.error_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function rowToSupervisor(row: WorkflowSupervisorRow): WorkflowSupervisorRecord {
  return {
    ownerToken: row.owner_token!,
    ownerEpoch: row.owner_epoch,
    ownerPid: row.owner_pid ?? undefined,
    status: row.status,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    heartbeatAt: row.heartbeat_at ?? undefined,
    wakeGeneration: row.wake_generation,
    startedAt: row.started_at ?? undefined,
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

function validateLease(leaseMs: number, label: string): void {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > MAX_CLAIM_LEASE_MS) {
    throw new WorkflowValidationError(
      `${label} lease must be between 1 and ${MAX_CLAIM_LEASE_MS} milliseconds`,
    );
  }
}

function retryEligibleAt(
  definition: WorkflowNodeDefinitionV1,
  attempt: number,
  error: JsonObject | undefined,
  now: string,
): string | undefined {
  const config = definition.config ?? {};
  const effectivePolicy = isObject(config.effectivePolicy) ? config.effectivePolicy : undefined;
  if (effectivePolicy?.access !== "read_only") return undefined;
  const retry = isObject(config.retry) ? config.retry : undefined;
  if (!retry) return undefined;
  const maxAttempts = readBoundedInteger(retry.maxAttempts, 1, 10, "Retry maxAttempts");
  if (attempt >= maxAttempts) return undefined;
  const code = typeof error?.code === "string" ? error.code : undefined;
  const retryOn = Array.isArray(retry.retryOn)
    ? retry.retryOn.filter((value): value is string => typeof value === "string")
    : [];
  if (!code || !retryOn.includes(code)) return undefined;
  const backoffMs = retry.backoffMs === undefined
    ? 0
    : readBoundedInteger(retry.backoffMs, 0, 60_000, "Retry backoffMs", 0);
  return new Date(new Date(now).getTime() + backoffMs * attempt).toISOString();
}

function readBoundedInteger(
  value: JsonValue | undefined,
  fallback: number,
  maximum: number,
  label: string,
  minimum = 1,
): number {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new WorkflowValidationError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return Number(value);
}

function requireNonEmptyString(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new WorkflowValidationError(`${label} must not be empty`);
  return normalized;
}

function createId(prefix: "wf_" | "wfn_"): string {
  return `${prefix}${randomUUID().replaceAll("-", "")}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
