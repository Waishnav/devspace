import { createHash } from "node:crypto";

export const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
export const OPERATION_ID_DESCRIPTION =
  "Stable ID for this logical side-effecting operation. Reuse the same ID only when retrying the exact same request after an unknown or lost response; use a new ID for a new operation.";

const DEFAULT_RECEIPT_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_MAX_RECEIPTS = 1_000;
const DEFAULT_MAX_TOMBSTONES = 100_000;

type StoredReceipt = {
  fingerprint: string;
  promise: Promise<unknown>;
  settledAt?: number;
};

type Tombstone = {
  fingerprint: string;
};

export interface OperationReceiptManagerOptions {
  receiptTtlMs?: number;
  maxReceipts?: number;
  maxTombstones?: number;
  now?: () => number;
}

export interface RunRecoverableOperationInput<T> {
  workspaceId: string;
  operationId: string;
  tool: string;
  request: unknown;
  execute: () => Promise<T>;
}

export interface RecoverableOperationResult<T> {
  value: T;
  replayed: boolean;
}

export class OperationReceiptManager {
  private readonly receipts = new Map<string, StoredReceipt>();
  private readonly tombstones = new Map<string, Tombstone>();
  private readonly receiptTtlMs: number;
  private readonly maxReceipts: number;
  private readonly maxTombstones: number;
  private readonly now: () => number;

  constructor(options: OperationReceiptManagerOptions = {}) {
    this.receiptTtlMs = options.receiptTtlMs ?? DEFAULT_RECEIPT_TTL_MS;
    this.maxReceipts = options.maxReceipts ?? DEFAULT_MAX_RECEIPTS;
    this.maxTombstones = options.maxTombstones ?? DEFAULT_MAX_TOMBSTONES;
    this.now = options.now ?? Date.now;

    if (!Number.isFinite(this.receiptTtlMs) || this.receiptTtlMs < 0) {
      throw new Error("Operation receipt TTL must be a non-negative number.");
    }
    if (!Number.isInteger(this.maxReceipts) || this.maxReceipts < 1) {
      throw new Error("Operation receipt capacity must be a positive integer.");
    }
    if (!Number.isInteger(this.maxTombstones) || this.maxTombstones < 1) {
      throw new Error("Operation tombstone capacity must be a positive integer.");
    }
  }

  async run<T>(input: RunRecoverableOperationInput<T>): Promise<RecoverableOperationResult<T>> {
    validateOperationId(input.operationId);
    this.compactExpiredReceipts();

    const key = receiptKey(input.workspaceId, input.operationId);
    const fingerprint = requestFingerprint(input.tool, input.request);
    const receipt = this.receipts.get(key);
    if (receipt) {
      assertFingerprintMatches(input.operationId, receipt.fingerprint, fingerprint);
      return {
        value: await receipt.promise as T,
        replayed: true,
      };
    }

    const tombstone = this.tombstones.get(key);
    if (tombstone) {
      assertFingerprintMatches(input.operationId, tombstone.fingerprint, fingerprint);
      throw new Error(
        `Operation ${input.operationId} was already executed, but its stored result has expired. Do not execute it again; inspect current state and use a new operationId for any new action.`,
      );
    }

    if (this.receipts.size >= this.maxReceipts) {
      throw new Error(
        "Operation receipt capacity reached. Refusing a new side-effecting operation rather than evicting a receipt that may still be needed for safe retry.",
      );
    }

    const stored: StoredReceipt = {
      fingerprint,
      promise: Promise.resolve().then(input.execute),
    };
    this.receipts.set(key, stored);
    void stored.promise.then(
      () => {
        stored.settledAt = this.now();
      },
      () => {
        stored.settledAt = this.now();
      },
    );

    return {
      value: await stored.promise as T,
      replayed: false,
    };
  }

  private compactExpiredReceipts(): void {
    const now = this.now();
    for (const [key, receipt] of this.receipts) {
      if (receipt.settledAt === undefined || now - receipt.settledAt < this.receiptTtlMs) {
        continue;
      }
      if (this.tombstones.size >= this.maxTombstones) {
        throw new Error(
          "Operation tombstone capacity reached. Refusing further side-effecting operations until DevSpace is restarted, so an old operation ID can never be silently reused.",
        );
      }
      this.receipts.delete(key);
      this.tombstones.set(key, { fingerprint: receipt.fingerprint });
    }
  }
}

const defaultOperationReceiptManager = new OperationReceiptManager();

export async function runRecoverableOperation<T>(
  input: RunRecoverableOperationInput<T>,
): Promise<RecoverableOperationResult<T>> {
  return defaultOperationReceiptManager.run(input);
}

export function recoverableStructuredContent<T extends Record<string, unknown>>(
  structuredContent: T,
  operationId: string,
  replayed: boolean,
): T & { operationId: string; operationReplayed: boolean } {
  return {
    ...structuredContent,
    operationId,
    operationReplayed: replayed,
  };
}

function receiptKey(workspaceId: string, operationId: string): string {
  return `${workspaceId}\u0000${operationId}`;
}

function requestFingerprint(tool: string, request: unknown): string {
  return createHash("sha256")
    .update(tool)
    .update("\u0000")
    .update(canonicalJson(request))
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "null" : encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

function validateOperationId(operationId: string): void {
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw new Error(
      "operationId must be 8-128 characters and contain only letters, digits, '.', '_', ':', or '-', starting with a letter or digit.",
    );
  }
}

function assertFingerprintMatches(
  operationId: string,
  expected: string,
  actual: string,
): void {
  if (expected !== actual) {
    throw new Error(
      `Operation ${operationId} was already used for a different request. Reuse an operationId only for an exact retry of the same tool call.`,
    );
  }
}
