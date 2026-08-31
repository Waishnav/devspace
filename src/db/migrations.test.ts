import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { databasePath, openDatabase } from "./client.js";

const stateDir = mkdtempSync(join(tmpdir(), "devspace-workflow-migration-test-"));

try {
  const legacy = new Database(databasePath(stateDir));
  legacy.exec(`
    create table devspace_schema_migrations (
      version integer primary key,
      name text not null,
      applied_at text not null
    );
    create table workspace_sessions (
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
    create table local_agent_sessions (
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
    create table workflow_runs (
      id text primary key,
      name text not null,
      source text not null,
      script_path text not null,
      script_hash text not null,
      workspace_root text not null,
      workspace_id text,
      args_json text not null default 'null',
      status text not null,
      error text,
      error_kind text,
      result_json text,
      pid integer,
      heartbeat_at text,
      cancel_requested text not null default 'false',
      resumed_from_run_id text,
      base_sha text,
      created_at text not null,
      started_at text,
      completed_at text,
      updated_at text not null
    );
    create table workflow_agent_calls (
      run_id text not null,
      call_index integer not null,
      cache_key text not null,
      prompt text not null default '',
      schema_json text,
      provider text not null,
      model text,
      effort text,
      profile_name text,
      profile_fingerprint text,
      label text,
      phase text,
      status text not null,
      from_cache text not null default 'false',
      provider_session_id text,
      response_text text,
      structured_json text,
      return_value_json text,
      error text,
      error_kind text,
      replay_match text,
      replayed_from_run_id text,
      replayed_from_call_index integer,
      replay_reason text,
      isolation text not null default 'shared',
      worktree_path text,
      dirty text,
      created_at text not null,
      started_at text,
      completed_at text,
      updated_at text not null,
      primary key (run_id, call_index)
    );
  `);
  const recordMigration = legacy.prepare(
    "insert into devspace_schema_migrations (version, name, applied_at) values (?, ?, ?)",
  );
  const oldStackMigrations = [
    "workspace-state",
    "oauth-state",
    "local-agent-sessions",
    "local-agent-effort-rename",
    "workflow-journal",
    "workflow-replay-provenance",
    "workflow-exact-replay",
    "workflow-agent-profiles",
    "workflow-observability",
  ];
  for (const [index, name] of oldStackMigrations.entries()) {
    recordMigration.run(index + 1, name, "2026-08-01T00:00:00.000Z");
  }
  legacy.close();

  const upgraded = openDatabase(stateDir);
  try {
    assert.equal(tableExists(upgraded.sqlite, "workspace_conversation_bindings"), true);
    assert.equal(tableExists(upgraded.sqlite, "workflow_agent_activity"), true);
    assert.equal(columnExists(upgraded.sqlite, "local_agent_sessions", "effort"), true);
    assert.equal(columnExists(upgraded.sqlite, "local_agent_sessions", "error_code"), true);
    assert.equal(columnExists(upgraded.sqlite, "local_agent_sessions", "usage_json"), true);
    assert.equal(columnExists(upgraded.sqlite, "local_agent_sessions", "activity_json"), true);
    assert.equal(columnExists(upgraded.sqlite, "workflow_runs", "phases_json"), true);
    assert.equal(
      columnExists(upgraded.sqlite, "workflow_agent_calls", "usage_total_tokens"),
      true,
    );
    assert.deepEqual(
      upgraded.sqlite
        .prepare("select version, name from devspace_schema_migrations where version >= 12 order by version")
        .all(),
      [
        { version: 12, name: "reconcile-workflow-stack-schema" },
        { version: 13, name: "local-agent-observability" },
      ],
    );
  } finally {
    upgraded.close();
  }
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}

function tableExists(sqlite: Database.Database, table: string): boolean {
  return sqlite.prepare(
    "select 1 from sqlite_master where type = 'table' and name = ?",
  ).get(table) !== undefined;
}

function columnExists(
  sqlite: Database.Database,
  table: string,
  column: string,
): boolean {
  const columns = sqlite.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((candidate) => candidate.name === column);
}

console.log("database migration tests passed");
