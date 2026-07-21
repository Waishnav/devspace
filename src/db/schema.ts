import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
    effort: text("effort"),
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
    name: text("name").notNull(),
    source: text("source").notNull(),
    scriptPath: text("script_path").notNull(),
    scriptHash: text("script_hash").notNull(),
    workspaceRoot: text("workspace_root").notNull(),
    workspaceId: text("workspace_id"),
    argsJson: text("args_json").notNull().default("null"),
    status: text("status").notNull(),
    error: text("error"),
    errorKind: text("error_kind"),
    resultJson: text("result_json"),
    pid: integer("pid"),
    heartbeatAt: text("heartbeat_at"),
    cancelRequested: text("cancel_requested").notNull().default("false"),
    resumedFromRunId: text("resumed_from_run_id"),
    baseSha: text("base_sha"),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("workflow_runs_status_updated_idx").on(table.status, table.updatedAt),
    index("workflow_runs_workspace_updated_idx").on(table.workspaceRoot, table.updatedAt),
    index("workflow_runs_heartbeat_idx").on(table.status, table.heartbeatAt),
    index("workflow_runs_resumed_from_idx").on(table.resumedFromRunId),
  ],
);

export const workflowEvents = sqliteTable(
  "workflow_events",
  {
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    phase: text("phase"),
    label: text("label"),
    dataJson: text("data_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.seq] }),
    index("workflow_events_run_seq_idx").on(table.runId, table.seq),
  ],
);

export const workflowAgentCalls = sqliteTable(
  "workflow_agent_calls",
  {
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    callIndex: integer("call_index").notNull(),
    cacheKey: text("cache_key").notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    effort: text("effort"),
    label: text("label"),
    phase: text("phase"),
    status: text("status").notNull(),
    fromCache: text("from_cache").notNull().default("false"),
    providerSessionId: text("provider_session_id"),
    responseText: text("response_text"),
    structuredJson: text("structured_json"),
    error: text("error"),
    isolation: text("isolation").notNull().default("shared"),
    worktreePath: text("worktree_path"),
    dirty: text("dirty"),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.callIndex] }),
    index("workflow_agent_calls_cache_key_idx").on(table.runId, table.cacheKey),
  ],
);

export type WorkspaceSessionRow = typeof workspaceSessions.$inferSelect;
export type NewWorkspaceSessionRow = typeof workspaceSessions.$inferInsert;
export type LoadedAgentFileRow = typeof loadedAgentFiles.$inferSelect;
export type NewLoadedAgentFileRow = typeof loadedAgentFiles.$inferInsert;
export type LocalAgentSessionRow = typeof localAgentSessions.$inferSelect;
export type NewLocalAgentSessionRow = typeof localAgentSessions.$inferInsert;
export type WorkflowRunRow = typeof workflowRuns.$inferSelect;
export type WorkflowEventRow = typeof workflowEvents.$inferSelect;
export type WorkflowAgentCallRow = typeof workflowAgentCalls.$inferSelect;
