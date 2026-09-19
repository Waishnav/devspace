import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
    recoveryKind: text("recovery_kind"),
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

export const workspaceConversationBindings = sqliteTable(
  "workspace_conversation_bindings",
  {
    conversationScopeId: text("conversation_scope_id").notNull(),
    targetKey: text("target_key").notNull(),
    workspaceSessionId: text("workspace_session_id")
      .notNull()
      .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationScopeId, table.targetKey] }),
    index("workspace_conversation_bindings_workspace_idx").on(table.workspaceSessionId),
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
    writeMode: text("write_mode").notNull().default("allowed"),
    providerSessionId: text("provider_session_id"),
    status: text("status").notNull(),
    latestResponse: text("latest_response"),
    error: text("error"),
    errorCode: text("error_code"),
    errorRetryable: text("error_retryable"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("local_agent_sessions_workspace_id_idx").on(table.workspaceId, table.updatedAt),
    index("local_agent_sessions_workspace_root_idx").on(table.workspaceRoot, table.updatedAt),
    index("local_agent_sessions_provider_session_id_idx").on(table.providerSessionId),
  ],
);

export const localAgentTurns = sqliteTable(
  "local_agent_turns",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    agentId: text("agent_id").notNull().references(() => localAgentSessions.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    status: text("status").notNull(),
    response: text("response"),
    error: text("error"),
    errorCode: text("error_code"),
    errorRetryable: text("error_retryable"),
    writeMode: text("write_mode").notNull().default("allowed"),
    model: text("model"),
    effort: text("effort"),
    attemptId: text("attempt_id"),
    workflowRunId: text("workflow_run_id"),
    workflowStepId: text("workflow_step_id"),
    workflowAttemptId: text("workflow_attempt_id"),
    retryAfterMs: integer("retry_after_ms"),
    resetAt: text("reset_at"),
    executionUncertain: text("execution_uncertain"),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    index("local_agent_turns_agent_id_idx").on(table.agentId, table.id),
    index("local_agent_turns_status_idx").on(table.status),
    index("local_agent_turns_workflow_run_idx").on(table.workflowRunId, table.id),
    index("local_agent_turns_workflow_step_idx").on(table.workflowStepId, table.id),
  ],
);

export const workflowBudgets = sqliteTable("workflow_budgets", {
  id: text("id").primaryKey(),
  totalOutputTokens: integer("total_output_tokens"),
  knownOutputTokens: integer("known_output_tokens").notNull().default(0),
  usageComplete: integer("usage_complete", { mode: "boolean" }).notNull().default(true),
  revision: integer("revision").notNull().default(0),
});

export const workflowRuns = sqliteTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    workspaceRoot: text("workspace_root").notNull(),
    lineageId: text("lineage_id").notNull(),
    budgetId: text("budget_id").notNull().references(() => workflowBudgets.id),
    resumedFromRunId: text("resumed_from_run_id"),
    state: text("state").notNull(),
    metaJson: text("meta_json").notNull(),
    scriptSource: text("script_source").notNull(),
    scriptHash: text("script_hash").notNull(),
    sourcePath: text("source_path"),
    argsPresent: integer("args_present", { mode: "boolean" }).notNull(),
    argsJson: text("args_json"),
    defaultsJson: text("defaults_json").notNull(),
    policyJson: text("policy_json").notNull(),
    runtimeVersion: text("runtime_version").notNull(),
    revision: integer("revision").notNull().default(0),
    executionGeneration: integer("execution_generation").notNull().default(1),
    resultJson: text("result_json"),
    resultArtifactId: text("result_artifact_id"),
    errorJson: text("error_json"),
    pauseReason: text("pause_reason"),
    nextEligibleAt: text("next_eligible_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (table) => [
    index("workflow_runs_workspace_idx").on(table.workspaceId, table.updatedAt),
    index("workflow_runs_state_idx").on(table.state, table.updatedAt),
    index("workflow_runs_lineage_idx").on(table.lineageId, table.createdAt),
  ],
);

export const workflowSteps = sqliteTable(
  "workflow_steps",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => workflowRuns.id, { onDelete: "cascade" }),
    parentStepId: text("parent_step_id"),
    kind: text("kind").notNull(),
    callSequence: integer("call_sequence").notNull(),
    logicalPath: text("logical_path").notNull(),
    requestHash: text("request_hash").notNull(),
    requestJson: text("request_json").notNull(),
    phase: text("phase"),
    label: text("label"),
    status: text("status").notNull(),
    agentId: text("agent_id"),
    workspaceId: text("workspace_id").notNull(),
    cachedFromStepId: text("cached_from_step_id"),
    outputJson: text("output_json"),
    errorJson: text("error_json"),
    deliverySequence: integer("delivery_sequence"),
    worktreeJson: text("worktree_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (table) => [
    uniqueIndex("workflow_steps_run_call_idx").on(table.runId, table.callSequence),
    index("workflow_steps_run_status_idx").on(table.runId, table.status),
    index("workflow_steps_parent_idx").on(table.parentStepId),
  ],
);

export const workflowAttempts = sqliteTable(
  "workflow_attempts",
  {
    id: text("id").primaryKey(),
    stepId: text("step_id").notNull().references(() => workflowSteps.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    agentId: text("agent_id").notNull(),
    agentTurnId: integer("agent_turn_id").notNull(),
    reason: text("reason").notNull(),
    state: text("state").notNull(),
    usageSequence: integer("usage_sequence").notNull().default(0),
    outputTokens: integer("output_tokens"),
    usageComplete: integer("usage_complete", { mode: "boolean" }).notNull().default(false),
    errorJson: text("error_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (table) => [
    uniqueIndex("workflow_attempts_step_number_idx").on(table.stepId, table.attemptNumber),
    uniqueIndex("workflow_attempts_turn_idx").on(table.agentTurnId),
  ],
);

export const workflowEvents = sqliteTable(
  "workflow_events",
  {
    runId: text("run_id").notNull().references(() => workflowRuns.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    stepId: text("step_id"),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.sequence] })],
);

export type WorkspaceSessionRow = typeof workspaceSessions.$inferSelect;
export type NewWorkspaceSessionRow = typeof workspaceSessions.$inferInsert;
export type LoadedAgentFileRow = typeof loadedAgentFiles.$inferSelect;
export type NewLoadedAgentFileRow = typeof loadedAgentFiles.$inferInsert;
export type WorkspaceConversationBindingRow = typeof workspaceConversationBindings.$inferSelect;
export type NewWorkspaceConversationBindingRow = typeof workspaceConversationBindings.$inferInsert;
export type LocalAgentSessionRow = typeof localAgentSessions.$inferSelect;
export type NewLocalAgentSessionRow = typeof localAgentSessions.$inferInsert;
export type LocalAgentTurnRow = typeof localAgentTurns.$inferSelect;
export type NewLocalAgentTurnRow = typeof localAgentTurns.$inferInsert;
export type WorkflowRunRow = typeof workflowRuns.$inferSelect;
export type NewWorkflowRunRow = typeof workflowRuns.$inferInsert;
export type WorkflowStepRow = typeof workflowSteps.$inferSelect;
export type NewWorkflowStepRow = typeof workflowSteps.$inferInsert;
export type WorkflowAttemptRow = typeof workflowAttempts.$inferSelect;
export type NewWorkflowAttemptRow = typeof workflowAttempts.$inferInsert;
export type WorkflowEventRow = typeof workflowEvents.$inferSelect;
export type NewWorkflowEventRow = typeof workflowEvents.$inferInsert;
export type WorkflowBudgetRow = typeof workflowBudgets.$inferSelect;
export type NewWorkflowBudgetRow = typeof workflowBudgets.$inferInsert;
