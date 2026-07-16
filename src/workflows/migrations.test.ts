import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { databasePath, openDatabase } from "../db/client.js";

const root = mkdtempSync(join(tmpdir(), "devspace-workflow-migrations-test-"));

try {
  testFreshSchema(join(root, "fresh"));
  testExistingMigrationCompatibility(join(root, "existing"));
  testMigrationRollback(join(root, "rollback"));
} finally {
  rmSync(root, { recursive: true, force: true });
}

function testFreshSchema(stateDir: string): void {
  const database = openDatabase(stateDir);
  try {
    assert.deepEqual(
      database.sqlite.prepare("select version, name from devspace_schema_migrations order by version").all(),
      [
        { version: 1, name: "workspace-state" },
        { version: 2, name: "oauth-state" },
        { version: 3, name: "local-agent-sessions" },
        { version: 4, name: "durable-workflows" },
        { version: 5, name: "workflow-supervisor" },
        { version: 6, name: "workflow-dag-scheduler" },
      ],
    );
    const tables = database.sqlite
      .prepare(
        `select name from sqlite_master
         where type = 'table' and name like 'workflow_%'
         order by name`,
      )
      .pluck()
      .all();
    assert.deepEqual(tables, [
      "workflow_edges",
      "workflow_events",
      "workflow_node_attempts",
      "workflow_nodes",
      "workflow_provider_events",
      "workflow_runs",
      "workflow_supervisor",
      "workflow_worktrees",
    ]);

    const edgeForeignKeys = database.sqlite.prepare("pragma foreign_key_list(workflow_edges)").all() as Array<{
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string;
    }>;
    assert.deepEqual(
      edgeForeignKeys
        .filter((row) => row.table === "workflow_nodes")
        .map((row) => [row.id, row.seq, row.from, row.to])
        .sort(),
      [
        [0, 0, "workflow_run_id", "workflow_run_id"],
        [0, 1, "to_node_id", "id"],
        [1, 0, "workflow_run_id", "workflow_run_id"],
        [1, 1, "from_node_id", "id"],
      ],
    );

    insertWorkflowFixture(database.sqlite);
    assert.throws(
      () =>
        database.sqlite
          .prepare(
            "insert into workflow_edges (workflow_run_id, from_node_id, to_node_id) values ('run-a', 'node-a', 'node-b')",
          )
          .run(),
      /FOREIGN KEY constraint failed/,
    );
    assert.throws(
      () =>
        database.sqlite
          .prepare(
            `insert into workflow_events
             (workflow_run_id, sequence, event_type, node_id, payload_json, created_at)
             values ('run-a', 1, 'invalid', 'node-b', '{}', '2026-01-01T00:00:00.000Z')`,
          )
          .run(),
      /FOREIGN KEY constraint failed/,
    );
  } finally {
    database.close();
  }
}

function testExistingMigrationCompatibility(stateDir: string): void {
  createVersion3Fixture(stateDir);
  const migrated = openDatabase(stateDir);
  try {
    assert.deepEqual(
      migrated.sqlite.prepare("select version from devspace_schema_migrations order by version").pluck().all(),
      [1, 2, 3, 4, 5, 6],
    );
    assert.deepEqual(migrated.sqlite.prepare("select * from workspace_sessions").all(), [
      {
        id: "workspace-1",
        root: "/tmp/workspace",
        status: "active",
        mode: "checkout",
        source_root: null,
        base_ref: null,
        base_sha: null,
        managed: "false",
        created_at: "2026-01-01T00:00:00.000Z",
        last_used_at: "2026-01-01T00:00:00.000Z",
      },
    ]);
    assert.equal(
      migrated.sqlite.prepare("select content from loaded_agent_files where path = 'CLAUDE.md'").pluck().get(),
      "instructions",
    );
    assert.equal(migrated.sqlite.prepare("select client_json from oauth_clients").pluck().get(), "{}");
    assert.equal(migrated.sqlite.prepare("select client_id from oauth_access_tokens").pluck().get(), "client-1");
    assert.equal(migrated.sqlite.prepare("select client_id from oauth_refresh_tokens").pluck().get(), "client-1");
    assert.equal(migrated.sqlite.prepare("select status from local_agent_sessions").pluck().get(), "active");

    assert.deepEqual(
      migrated.sqlite
        .prepare("pragma table_info(local_agent_sessions)")
        .all()
        .map((row) => (row as { name: string }).name),
      [
        "id",
        "workspace_id",
        "workspace_root",
        "profile_name",
        "provider",
        "model",
        "thinking",
        "provider_session_id",
        "status",
        "latest_response",
        "error",
        "created_at",
        "updated_at",
      ],
    );
    for (const index of [
      "workspace_sessions_root_idx",
      "workspace_sessions_status_idx",
      "loaded_agent_files_path_idx",
      "oauth_clients_issued_at_idx",
      "oauth_access_tokens_client_id_idx",
      "oauth_access_tokens_expires_at_idx",
      "oauth_refresh_tokens_client_id_idx",
      "oauth_refresh_tokens_expires_at_idx",
      "local_agent_sessions_workspace_id_idx",
      "local_agent_sessions_workspace_root_idx",
      "local_agent_sessions_provider_session_id_idx",
    ]) {
      assert.equal(
        migrated.sqlite
          .prepare("select count(*) from sqlite_master where type = 'index' and name = ?")
          .pluck()
          .get(index),
        1,
        `missing pre-v4 index ${index}`,
      );
    }
    assert.equal(
      migrated.sqlite
        .prepare("select count(*) from sqlite_master where type = 'table' and name like 'workflow_%'")
        .pluck()
        .get(),
      8,
    );
  } finally {
    migrated.close();
  }
}

function testMigrationRollback(stateDir: string): void {
  createVersion3Fixture(stateDir);
  const incompatible = new Database(databasePath(stateDir));
  try {
    incompatible.exec("create table workflow_events (legacy_value text not null)");
  } finally {
    incompatible.close();
  }

  assert.throws(() => openDatabase(stateDir), /no such column: workflow_run_id/);

  const sqlite = new Database(databasePath(stateDir));
  try {
    assert.deepEqual(
      sqlite.prepare("select version from devspace_schema_migrations order by version").pluck().all(),
      [1, 2, 3],
    );
    assert.equal(sqlite.prepare("select count(*) from workspace_sessions").pluck().get(), 1);
    assert.equal(sqlite.prepare("select count(*) from local_agent_sessions").pluck().get(), 1);
    assert.deepEqual(
      sqlite
        .prepare("select name from sqlite_master where type = 'table' and name like 'workflow_%' order by name")
        .pluck()
        .all(),
      ["workflow_events"],
    );
    assert.deepEqual(
      sqlite
        .prepare("pragma table_info(workflow_events)")
        .all()
        .map((row) => (row as { name: string }).name),
      ["legacy_value"],
    );
  } finally {
    sqlite.close();
  }
}

function createVersion3Fixture(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const initialized = openDatabase(stateDir);
  try {
    initialized.sqlite.exec(`
      drop table workflow_worktrees;
      drop table workflow_provider_events;
      drop table workflow_node_attempts;
      drop table workflow_supervisor;
      drop table workflow_edges;
      drop table workflow_events;
      drop table workflow_nodes;
      drop table workflow_runs;
      delete from devspace_schema_migrations where version in (4, 5, 6);

      insert into workspace_sessions (
        id, root, status, mode, source_root, base_ref, base_sha, managed, created_at, last_used_at
      ) values (
        'workspace-1', '/tmp/workspace', 'active', 'checkout', null, null, null, 'false',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      insert into loaded_agent_files (
        workspace_session_id, path, content_hash, content, loaded_at, last_seen_at
      ) values (
        'workspace-1', 'CLAUDE.md', 'hash', 'instructions',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      insert into oauth_clients (client_id, client_json, issued_at) values ('client-1', '{}', 1);
      insert into oauth_access_tokens (
        token_hash, client_id, scopes_json, expires_at, resource
      ) values ('access-1', 'client-1', '[]', 2, null);
      insert into oauth_refresh_tokens (
        token_hash, client_id, scopes_json, expires_at, resource
      ) values ('refresh-1', 'client-1', '[]', 3, null);
      insert into local_agent_sessions (
        id, workspace_id, workspace_root, profile_name, provider, model, thinking,
        provider_session_id, status, latest_response, error, created_at, updated_at
      ) values (
        'agent-1', 'workspace-1', '/tmp/workspace', 'default', 'claude', null, null,
        null, 'active', null, null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
    `);
  } finally {
    initialized.close();
  }
}

function insertWorkflowFixture(sqlite: Database.Database): void {
  const insertRun = sqlite.prepare(
    `insert into workflow_runs (
      id, definition_version, status, definition_json, input_json, policy_json,
      request_hash, created_at, updated_at
    ) values (?, 1, 'queued', '{}', '{}', '{}', 'hash', ?, ?)`,
  );
  const now = "2026-01-01T00:00:00.000Z";
  insertRun.run("run-a", now, now);
  insertRun.run("run-b", now, now);
  const insertNode = sqlite.prepare(
    `insert into workflow_nodes (
      id, workflow_run_id, node_key, node_type, status, definition_json, created_at, updated_at
    ) values (?, ?, 'agent', 'agent', 'ready', '{}', ?, ?)`,
  );
  insertNode.run("node-a", "run-a", now, now);
  insertNode.run("node-b", "run-b", now, now);
}
