import type { AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { openDatabase, type DatabaseHandle } from "./db/client.js";

export interface AuthorizationCodeRecord {
  clientId: string;
  params: AuthorizationParams;
  expiresAtMs: number;
}

export interface TokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: URL;
}

type TokenKind = "access" | "refresh";

interface SerializedAuthorizationParams extends Omit<AuthorizationParams, "resource"> {
  resource?: string;
}

export class SqliteOAuthStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
    this.migrate();
    this.deleteExpired();
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.database.sqlite
      .prepare("select client_json from oauth_clients where client_id = ?")
      .get(clientId) as { client_json: string } | undefined;
    return row ? (JSON.parse(row.client_json) as OAuthClientInformationFull) : undefined;
  }

  saveClient(client: OAuthClientInformationFull): void {
    this.database.sqlite
      .prepare("insert into oauth_clients (client_id, client_json, created_at) values (?, ?, ?)")
      .run(client.client_id, JSON.stringify(client), client.client_id_issued_at);
  }

  getAuthorizationCode(codeHash: string): AuthorizationCodeRecord | undefined {
    const row = this.database.sqlite
      .prepare("select client_id, params_json, expires_at_ms from oauth_authorization_codes where code_hash = ?")
      .get(codeHash) as {
        client_id: string;
        params_json: string;
        expires_at_ms: number;
      } | undefined;
    if (!row) return undefined;
    if (row.expires_at_ms < Date.now()) {
      this.deleteAuthorizationCode(codeHash);
      return undefined;
    }
    return {
      clientId: row.client_id,
      params: deserializeAuthorizationParams(row.params_json),
      expiresAtMs: row.expires_at_ms,
    };
  }

  saveAuthorizationCode(codeHash: string, record: AuthorizationCodeRecord): void {
    this.database.sqlite
      .prepare("insert or replace into oauth_authorization_codes (code_hash, client_id, params_json, expires_at_ms) values (?, ?, ?, ?)")
      .run(codeHash, record.clientId, serializeAuthorizationParams(record.params), record.expiresAtMs);
  }

  deleteAuthorizationCode(codeHash: string): void {
    this.database.sqlite
      .prepare("delete from oauth_authorization_codes where code_hash = ?")
      .run(codeHash);
  }

  getAccessToken(tokenHash: string): TokenRecord | undefined {
    return this.getToken("access", tokenHash);
  }

  saveAccessToken(tokenHash: string, record: TokenRecord): void {
    this.saveToken("access", tokenHash, record);
  }

  deleteAccessToken(tokenHash: string): void {
    this.deleteToken("access", tokenHash);
  }

  getRefreshToken(tokenHash: string): TokenRecord | undefined {
    return this.getToken("refresh", tokenHash);
  }

  saveRefreshToken(tokenHash: string, record: TokenRecord): void {
    this.saveToken("refresh", tokenHash, record);
  }

  deleteRefreshToken(tokenHash: string): void {
    this.deleteToken("refresh", tokenHash);
  }

  revokeToken(tokenHash: string): void {
    this.database.sqlite
      .prepare("delete from oauth_tokens where token_hash = ?")
      .run(tokenHash);
  }

  close(): void {
    this.database.close();
  }

  private migrate(): void {
    this.database.sqlite.exec(`
      create table if not exists oauth_clients (
        client_id text primary key,
        client_json text not null,
        created_at integer not null
      );
      create table if not exists oauth_authorization_codes (
        code_hash text primary key,
        client_id text not null,
        params_json text not null,
        expires_at_ms integer not null,
        foreign key (client_id) references oauth_clients(client_id) on delete cascade
      );
      create index if not exists oauth_authorization_codes_expiry_idx
        on oauth_authorization_codes(expires_at_ms);
      create table if not exists oauth_tokens (
        token_hash text not null,
        token_kind text not null,
        client_id text not null,
        scopes_json text not null,
        expires_at integer not null,
        resource text,
        primary key (token_hash, token_kind),
        foreign key (client_id) references oauth_clients(client_id) on delete cascade
      );
      create index if not exists oauth_tokens_expiry_idx on oauth_tokens(expires_at);
    `);
  }

  private deleteExpired(): void {
    this.database.sqlite
      .prepare("delete from oauth_authorization_codes where expires_at_ms < ?")
      .run(Date.now());
    this.database.sqlite
      .prepare("delete from oauth_tokens where expires_at < ?")
      .run(Math.floor(Date.now() / 1000));
  }

  private getToken(kind: TokenKind, tokenHash: string): TokenRecord | undefined {
    const row = this.database.sqlite
      .prepare("select client_id, scopes_json, expires_at, resource from oauth_tokens where token_hash = ? and token_kind = ?")
      .get(tokenHash, kind) as {
        client_id: string;
        scopes_json: string;
        expires_at: number;
        resource: string | null;
      } | undefined;
    if (!row) return undefined;
    if (row.expires_at < Math.floor(Date.now() / 1000)) {
      this.deleteToken(kind, tokenHash);
      return undefined;
    }
    return {
      clientId: row.client_id,
      scopes: JSON.parse(row.scopes_json) as string[],
      expiresAt: row.expires_at,
      resource: row.resource ? new URL(row.resource) : undefined,
    };
  }

  private saveToken(kind: TokenKind, tokenHash: string, record: TokenRecord): void {
    this.database.sqlite
      .prepare("insert or replace into oauth_tokens (token_hash, token_kind, client_id, scopes_json, expires_at, resource) values (?, ?, ?, ?, ?, ?)")
      .run(
        tokenHash,
        kind,
        record.clientId,
        JSON.stringify(record.scopes),
        record.expiresAt,
        record.resource?.href ?? null,
      );
  }

  private deleteToken(kind: TokenKind, tokenHash: string): void {
    this.database.sqlite
      .prepare("delete from oauth_tokens where token_hash = ? and token_kind = ?")
      .run(tokenHash, kind);
  }
}

function serializeAuthorizationParams(params: AuthorizationParams): string {
  return JSON.stringify({ ...params, resource: params.resource?.href });
}

function deserializeAuthorizationParams(value: string): AuthorizationParams {
  const parsed = JSON.parse(value) as SerializedAuthorizationParams;
  return {
    ...parsed,
    resource: parsed.resource ? new URL(parsed.resource) : undefined,
  };
}
