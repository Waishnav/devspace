import {
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const workspaceSessions = sqliteTable(
  "workspace_sessions",
  {
    id: text("id").primaryKey(),
    root: text("root").notNull(),
    status: text("status").notNull().default("active"),
    mode: text("mode").notNull().default("checkout"),
    sourceRoot: text("source_root"),
    baseRef: text("base_ref"),
    baseSha: text("base_sha"),
    managed: text("managed").notNull().default("false"),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (table) => [
    index("workspace_sessions_root_idx").on(table.root, table.lastUsedAt),
    index("workspace_sessions_status_idx").on(table.status, table.lastUsedAt),
  ],
);

export const loadedAgentFiles = sqliteTable(
  "loaded_agent_files",
  {
    workspaceSessionId: text("workspace_session_id")
      .notNull()
      .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    contentHash: text("content_hash").notNull(),
    content: text("content").notNull(),
    loadedAt: text("loaded_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceSessionId, table.path] }),
    index("loaded_agent_files_path_idx").on(table.path),
  ],
);

export const oauthClients = sqliteTable(
  "oauth_clients",
  {
    clientId: text("client_id").primaryKey(),
    clientJson: text("client_json").notNull(),
    issuedAt: integer("issued_at").notNull(),
  },
);

export const oauthAccessTokens = sqliteTable(
  "oauth_access_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resource: text("resource"),
  },
);

export const oauthRefreshTokens = sqliteTable(
  "oauth_refresh_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resource: text("resource"),
  },
);

export const localAgentSessions = sqliteTable(
  "local_agent_sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id"),
    workspaceRoot: text("workspace_root").notNull(),
    profileName: text("profile_name").notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    thinking: text("thinking"),
    providerSessionId: text("provider_session_id"),
    status: text("status").notNull(),
    latestResponse: text("latest_response"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("local_agent_sessions_workspace_id_idx").on(table.workspaceId, table.updatedAt),
    index("local_agent_sessions_workspace_root_idx").on(table.workspaceRoot, table.updatedAt),
    index("local_agent_sessions_provider_session_id_idx").on(table.providerSessionId),
  ],
);

export const workflowRuns = sqliteTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(),
    definitionVersion: integer("definition_version").notNull(),
    status: text("status").notNull(),
    definitionJson: text("definition_json").notNull(),
    inputJson: text("input_json").notNull(),
    policyJson: text("policy_json").notNull(),
    idempotencyKey: text("idempotency_key").unique(),
    requestHash: text("request_hash").notNull(),
    workspaceId: text("workspace_id"),
    workspaceRoot: text("workspace_root"),
    resultJson: text("result_json"),
    errorJson: text("error_json"),
    cancellationRequestedAt: text("cancellation_requested_at"),
    eventSequence: integer("event_sequence").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
  },
  (table) => [index("workflow_runs_status_idx").on(table.status, table.createdAt)],
);

export const workflowNodes = sqliteTable(
  "workflow_nodes",
  {
    id: text("id").primaryKey(),
    workflowRunId: text("workflow_run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    nodeKey: text("node_key").notNull(),
    nodeType: text("node_type").notNull(),
    status: text("status").notNull(),
    definitionJson: text("definition_json").notNull(),
    attempt: integer("attempt").notNull().default(0),
    claimToken: text("claim_token"),
    claimedAt: text("claimed_at"),
    claimExpiresAt: text("claim_expires_at"),
    supervisorOwnerToken: text("supervisor_owner_token"),
    supervisorOwnerEpoch: integer("supervisor_owner_epoch"),
    heartbeatAt: text("heartbeat_at"),
    resultJson: text("result_json"),
    errorJson: text("error_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    uniqueIndex("workflow_nodes_run_key_idx").on(table.workflowRunId, table.nodeKey),
    uniqueIndex("workflow_nodes_run_id_idx").on(table.workflowRunId, table.id),
    index("workflow_nodes_status_idx").on(table.workflowRunId, table.status, table.createdAt),
  ],
);

export const workflowEdges = sqliteTable(
  "workflow_edges",
  {
    workflowRunId: text("workflow_run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    fromNodeId: text("from_node_id").notNull(),
    toNodeId: text("to_node_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workflowRunId, table.fromNodeId, table.toNodeId] }),
    foreignKey({
      columns: [table.workflowRunId, table.fromNodeId],
      foreignColumns: [workflowNodes.workflowRunId, workflowNodes.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workflowRunId, table.toNodeId],
      foreignColumns: [workflowNodes.workflowRunId, workflowNodes.id],
    }).onDelete("cascade"),
    index("workflow_edges_to_node_idx").on(table.workflowRunId, table.toNodeId),
  ],
);

export const workflowEvents = sqliteTable(
  "workflow_events",
  {
    workflowRunId: text("workflow_run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    eventType: text("event_type").notNull(),
    nodeId: text("node_id"),
    payloadJson: text("payload_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workflowRunId, table.sequence] }),
    foreignKey({
      columns: [table.workflowRunId, table.nodeId],
      foreignColumns: [workflowNodes.workflowRunId, workflowNodes.id],
    }),
    index("workflow_events_cursor_idx").on(table.workflowRunId, table.sequence),
  ],
);

export const workflowSupervisor = sqliteTable("workflow_supervisor", {
  id: integer("id").primaryKey(),
  ownerToken: text("owner_token"),
  ownerEpoch: integer("owner_epoch").notNull().default(0),
  ownerPid: integer("owner_pid"),
  status: text("status").notNull().default("stopped"),
  leaseExpiresAt: text("lease_expires_at"),
  heartbeatAt: text("heartbeat_at"),
  wakeGeneration: integer("wake_generation").notNull().default(0),
  startedAt: text("started_at"),
  lastError: text("last_error"),
});

export const workflowNodeAttempts = sqliteTable(
  "workflow_node_attempts",
  {
    nodeId: text("node_id").notNull(),
    workflowRunId: text("workflow_run_id").notNull(),
    nodeKey: text("node_key").notNull(),
    attempt: integer("attempt").notNull(),
    claimToken: text("claim_token").notNull(),
    supervisorOwnerToken: text("supervisor_owner_token").notNull(),
    supervisorOwnerEpoch: integer("supervisor_owner_epoch").notNull(),
    provider: text("provider").notNull(),
    phase: text("phase").notNull(),
    providerSessionId: text("provider_session_id"),
    heartbeatAt: text("heartbeat_at"),
    cancellationRequestedAt: text("cancellation_requested_at"),
    terminalStatus: text("terminal_status"),
    resultJson: text("result_json"),
    errorJson: text("error_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    primaryKey({ columns: [table.nodeId, table.attempt] }),
    uniqueIndex("workflow_node_attempts_claim_idx").on(table.nodeId, table.attempt, table.claimToken),
    foreignKey({
      columns: [table.workflowRunId, table.nodeId],
      foreignColumns: [workflowNodes.workflowRunId, workflowNodes.id],
    }).onDelete("cascade"),
    index("workflow_node_attempts_run_idx").on(table.workflowRunId, table.nodeKey, table.attempt),
  ],
);

export const workflowProviderEvents = sqliteTable(
  "workflow_provider_events",
  {
    nodeId: text("node_id").notNull(),
    attempt: integer("attempt").notNull(),
    sourceSequence: integer("source_sequence").notNull(),
    workflowSequence: integer("workflow_sequence").notNull(),
    eventType: text("event_type").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.nodeId, table.attempt, table.sourceSequence] }),
    foreignKey({
      columns: [table.nodeId, table.attempt],
      foreignColumns: [workflowNodeAttempts.nodeId, workflowNodeAttempts.attempt],
    }).onDelete("cascade"),
  ],
);

export type WorkspaceSessionRow = typeof workspaceSessions.$inferSelect;
export type NewWorkspaceSessionRow = typeof workspaceSessions.$inferInsert;
export type LoadedAgentFileRow = typeof loadedAgentFiles.$inferSelect;
export type NewLoadedAgentFileRow = typeof loadedAgentFiles.$inferInsert;
export type LocalAgentSessionRow = typeof localAgentSessions.$inferSelect;
export type NewLocalAgentSessionRow = typeof localAgentSessions.$inferInsert;
export type WorkflowRunRow = typeof workflowRuns.$inferSelect;
export type NewWorkflowRunRow = typeof workflowRuns.$inferInsert;
export type WorkflowNodeRow = typeof workflowNodes.$inferSelect;
export type NewWorkflowNodeRow = typeof workflowNodes.$inferInsert;
export type WorkflowEdgeRow = typeof workflowEdges.$inferSelect;
export type NewWorkflowEdgeRow = typeof workflowEdges.$inferInsert;
export type WorkflowEventRow = typeof workflowEvents.$inferSelect;
export type NewWorkflowEventRow = typeof workflowEvents.$inferInsert;
