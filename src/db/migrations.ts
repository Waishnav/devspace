import type Database from "better-sqlite3";

interface Migration {
  version: number;
  name: string;
  up(sqlite: Database.Database): void;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: "workspace-state",
    up: migrateWorkspaceState,
  },
  {
    version: 2,
    name: "oauth-state",
    up: migrateOAuthState,
  },
  {
    version: 3,
    name: "local-agent-sessions",
    up: migrateLocalAgentSessions,
  },
  {
    version: 4,
    name: "durable-workflows",
    up: migrateDurableWorkflows,
  },
  {
    version: 5,
    name: "workflow-supervisor",
    up: migrateWorkflowSupervisor,
  },
  {
    version: 6,
    name: "workflow-dag-scheduler",
    up: migrateWorkflowDagScheduler,
  },
  {
    version: 7,
    name: "workflow-js-runtime",
    up: migrateWorkflowJsRuntime,
  },
];

export function migrateDatabase(sqlite: Database.Database): void {
  const migrate = sqlite.transaction(() => {
    sqlite.exec(`
      create table if not exists devspace_schema_migrations (
        version integer primary key,
        name text not null,
        applied_at text not null
      );
    `);

    const applied = new Set(
      (
        sqlite.prepare("select version from devspace_schema_migrations").all() as Array<{
          version: number;
        }>
      ).map((row) => row.version),
    );
    const recordMigration = sqlite.prepare(
      "insert into devspace_schema_migrations (version, name, applied_at) values (?, ?, ?)",
    );

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      migration.up(sqlite);
      recordMigration.run(migration.version, migration.name, new Date().toISOString());
    }
  });

  migrate.immediate();
}

function migrateWorkspaceState(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists workspace_sessions (
      id text primary key,
      root text not null,
      status text not null default 'active',
      mode text not null default 'checkout',
      source_root text,
      base_ref text,
      base_sha text,
      managed text not null default 'false',
      created_at text not null,
      last_used_at text not null
    );

    create index if not exists workspace_sessions_root_idx
      on workspace_sessions(root, last_used_at desc);

    create index if not exists workspace_sessions_status_idx
      on workspace_sessions(status, last_used_at desc);

    create table if not exists loaded_agent_files (
      workspace_session_id text not null,
      path text not null,
      content_hash text not null,
      content text not null,
      loaded_at text not null,
      last_seen_at text not null,
      primary key (workspace_session_id, path),
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

    create index if not exists loaded_agent_files_path_idx
      on loaded_agent_files(path);
  `);

  addColumnIfMissing(sqlite, "workspace_sessions", "mode", "text not null default 'checkout'");
  addColumnIfMissing(sqlite, "workspace_sessions", "source_root", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "base_ref", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "base_sha", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "managed", "text not null default 'false'");
}

function migrateOAuthState(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists oauth_clients (
      client_id text primary key,
      client_json text not null,
      issued_at integer not null
    );

    create index if not exists oauth_clients_issued_at_idx
      on oauth_clients(issued_at desc);

    create table if not exists oauth_access_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_access_tokens_client_id_idx
      on oauth_access_tokens(client_id);

    create index if not exists oauth_access_tokens_expires_at_idx
      on oauth_access_tokens(expires_at);

    create table if not exists oauth_refresh_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_refresh_tokens_client_id_idx
      on oauth_refresh_tokens(client_id);

    create index if not exists oauth_refresh_tokens_expires_at_idx
      on oauth_refresh_tokens(expires_at);
  `);
}

function migrateLocalAgentSessions(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists local_agent_sessions (
      id text primary key,
      workspace_id text,
      workspace_root text not null,
      profile_name text not null,
      provider text not null,
      model text,
      thinking text,
      provider_session_id text,
      status text not null,
      latest_response text,
      error text,
      created_at text not null,
      updated_at text not null
    );

    create index if not exists local_agent_sessions_workspace_id_idx
      on local_agent_sessions(workspace_id, updated_at desc);

    create index if not exists local_agent_sessions_workspace_root_idx
      on local_agent_sessions(workspace_root, updated_at desc);

    create index if not exists local_agent_sessions_provider_session_id_idx
      on local_agent_sessions(provider_session_id);
  `);

  addColumnIfMissing(sqlite, "local_agent_sessions", "thinking", "text");
}

function migrateDurableWorkflows(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists workflow_runs (
      id text primary key,
      definition_version integer not null,
      status text not null,
      definition_json text not null,
      input_json text not null,
      policy_json text not null,
      idempotency_key text unique,
      request_hash text not null,
      result_json text,
      error_json text,
      cancellation_requested_at text,
      event_sequence integer not null default 0,
      created_at text not null,
      updated_at text not null,
      started_at text,
      completed_at text
    );

    create index if not exists workflow_runs_status_idx
      on workflow_runs(status, created_at);

    create table if not exists workflow_nodes (
      id text primary key,
      workflow_run_id text not null,
      node_key text not null,
      node_type text not null,
      status text not null,
      definition_json text not null,
      attempt integer not null default 0,
      claim_token text,
      claimed_at text,
      claim_expires_at text,
      result_json text,
      error_json text,
      created_at text not null,
      updated_at text not null,
      completed_at text,
      foreign key (workflow_run_id) references workflow_runs(id) on delete cascade
    );

    create unique index if not exists workflow_nodes_run_key_idx
      on workflow_nodes(workflow_run_id, node_key);

    create unique index if not exists workflow_nodes_run_id_idx
      on workflow_nodes(workflow_run_id, id);

    create index if not exists workflow_nodes_status_idx
      on workflow_nodes(workflow_run_id, status, created_at);

    create table if not exists workflow_edges (
      workflow_run_id text not null,
      from_node_id text not null,
      to_node_id text not null,
      primary key (workflow_run_id, from_node_id, to_node_id),
      foreign key (workflow_run_id) references workflow_runs(id) on delete cascade,
      foreign key (workflow_run_id, from_node_id)
        references workflow_nodes(workflow_run_id, id) on delete cascade,
      foreign key (workflow_run_id, to_node_id)
        references workflow_nodes(workflow_run_id, id) on delete cascade
    );

    create index if not exists workflow_edges_to_node_idx
      on workflow_edges(workflow_run_id, to_node_id);

    create table if not exists workflow_events (
      workflow_run_id text not null,
      sequence integer not null,
      event_type text not null,
      node_id text,
      payload_json text not null,
      created_at text not null,
      primary key (workflow_run_id, sequence),
      foreign key (workflow_run_id) references workflow_runs(id) on delete cascade,
      foreign key (workflow_run_id, node_id)
        references workflow_nodes(workflow_run_id, id)
    );

    create index if not exists workflow_events_cursor_idx
      on workflow_events(workflow_run_id, sequence);
  `);
}

function migrateWorkflowSupervisor(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "workflow_runs", "workspace_id", "text");
  addColumnIfMissing(sqlite, "workflow_runs", "workspace_root", "text");
  addColumnIfMissing(sqlite, "workflow_nodes", "supervisor_owner_token", "text");
  addColumnIfMissing(sqlite, "workflow_nodes", "supervisor_owner_epoch", "integer");
  addColumnIfMissing(sqlite, "workflow_nodes", "heartbeat_at", "text");

  sqlite.exec(`
    create table if not exists workflow_supervisor (
      id integer primary key check (id = 1),
      owner_token text,
      owner_epoch integer not null default 0,
      owner_pid integer,
      status text not null default 'stopped'
        check (status in ('stopped', 'starting', 'running', 'stopping')),
      lease_expires_at text,
      heartbeat_at text,
      wake_generation integer not null default 0,
      started_at text,
      last_error text
    );

    insert or ignore into workflow_supervisor (id) values (1);

    create table if not exists workflow_node_attempts (
      node_id text not null,
      workflow_run_id text not null,
      node_key text not null,
      attempt integer not null,
      claim_token text not null,
      supervisor_owner_token text not null,
      supervisor_owner_epoch integer not null,
      provider text not null,
      phase text not null check (phase in ('claimed', 'dispatching', 'running', 'cancelling', 'terminal')),
      provider_session_id text,
      heartbeat_at text,
      cancellation_requested_at text,
      terminal_status text check (terminal_status in ('succeeded', 'failed', 'cancelled')),
      result_json text,
      error_json text,
      created_at text not null,
      updated_at text not null,
      completed_at text,
      primary key (node_id, attempt),
      unique (node_id, attempt, claim_token),
      foreign key (workflow_run_id, node_id)
        references workflow_nodes(workflow_run_id, id) on delete cascade
    );

    create index if not exists workflow_node_attempts_run_idx
      on workflow_node_attempts(workflow_run_id, node_key, attempt);

    create table if not exists workflow_provider_events (
      node_id text not null,
      attempt integer not null,
      source_sequence integer not null,
      workflow_sequence integer not null,
      event_type text not null,
      payload_json text not null,
      created_at text not null,
      primary key (node_id, attempt, source_sequence),
      foreign key (node_id, attempt)
        references workflow_node_attempts(node_id, attempt) on delete cascade
    );

    create index if not exists workflow_nodes_claimable_idx
      on workflow_nodes(status, claim_expires_at, created_at);

    create index if not exists workflow_runs_workspace_idx
      on workflow_runs(workspace_id, workspace_root, created_at);
  `);
}

function migrateWorkflowDagScheduler(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "workflow_runs", "max_concurrency", "integer not null default 1");
  addColumnIfMissing(sqlite, "workflow_runs", "last_dispatched_at", "text");
  addColumnIfMissing(sqlite, "workflow_nodes", "next_eligible_at", "text");

  sqlite.exec(`
    create table if not exists workflow_worktrees (
      workflow_run_id text not null,
      node_key text not null,
      attempt integer not null,
      path text not null unique,
      source_root text not null,
      base_sha text not null,
      state text not null check (state in ('allocated', 'active', 'preserved', 'removed', 'cleanup_failed')),
      retain_until text,
      cleanup_error text,
      created_at text not null,
      updated_at text not null,
      primary key (workflow_run_id, node_key, attempt),
      foreign key (workflow_run_id) references workflow_runs(id) on delete cascade
    );

    create index if not exists workflow_runs_dispatch_idx
      on workflow_runs(status, last_dispatched_at, created_at);

    create index if not exists workflow_nodes_retry_idx
      on workflow_nodes(workflow_run_id, status, next_eligible_at);

    create index if not exists workflow_worktrees_cleanup_idx
      on workflow_worktrees(state, retain_until);
  `);
}

function migrateWorkflowJsRuntime(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists workflow_runtime_runs (
      id text primary key,
      workspace_id text not null,
      workspace_root text not null,
      source_hash text not null,
      args_json text not null,
      metadata_json text not null,
      budget_json text not null,
      idempotency_key text,
      request_hash text not null,
      status text not null check (status in ('running', 'succeeded', 'failed', 'cancelled')),
      result_json text,
      error_json text,
      created_at text not null,
      updated_at text not null,
      completed_at text,
      unique (workspace_id, workspace_root, idempotency_key)
    );

    create table if not exists workflow_runtime_calls (
      runtime_run_id text not null,
      call_index integer not null,
      request_hash text not null,
      request_json text not null,
      workflow_run_id text,
      status text not null check (status in ('pending', 'running', 'succeeded', 'failed')),
      result_json text,
      error_json text,
      created_at text not null,
      updated_at text not null,
      completed_at text,
      primary key (runtime_run_id, call_index),
      foreign key (runtime_run_id) references workflow_runtime_runs(id) on delete cascade,
      foreign key (workflow_run_id) references workflow_runs(id) on delete set null
    );

    create table if not exists workflow_runtime_events (
      runtime_run_id text not null,
      sequence integer not null,
      event_type text not null,
      payload_json text not null,
      created_at text not null,
      primary key (runtime_run_id, sequence),
      foreign key (runtime_run_id) references workflow_runtime_runs(id) on delete cascade
    );

    create index if not exists workflow_runtime_runs_workspace_idx
      on workflow_runtime_runs(workspace_id, workspace_root, created_at);

    create index if not exists workflow_runtime_calls_workflow_idx
      on workflow_runtime_calls(workflow_run_id);
  `);
}

function addColumnIfMissing(
  sqlite: Database.Database,
  table: "workspace_sessions" | "local_agent_sessions" | "workflow_runs" | "workflow_nodes",
  column: string,
  definition: string,
): void {
  const columns = sqlite.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((existingColumn) => existingColumn.name === column)) return;

  sqlite.exec(`alter table ${table} add column ${column} ${definition}`);
}
