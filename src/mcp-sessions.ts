export interface ClosableMcpTransport {
  close(): Promise<void>;
}

export interface McpSessionCloseResult {
  sessionId: string;
  error?: unknown;
}

interface McpSessionEntry<TTransport> {
  transport: TTransport;
  lastActivityAt: number;
  activeResponses: number;
  closing: boolean;
}

export interface McpSessionRegistryOptions {
  now?: () => number;
  maxSessions?: number;
}

export interface McpSessionReservation<TTransport> {
  readonly evictedSessionId?: string;
  commit(
    sessionId: string,
    transport: TTransport,
    options?: { active?: boolean },
  ): Promise<boolean>;
  release(): void;
}

export type McpSessionReservationResult<TTransport> =
  | {
      ok: true;
      reservation: McpSessionReservation<TTransport>;
    }
  | {
      ok: false;
      reason: "capacity_exhausted" | "close_failed";
      sessionId?: string;
      error?: unknown;
    };

const DEFAULT_MAX_SESSIONS = 256;

export class McpSessionRegistry<TTransport extends ClosableMcpTransport> {
  private readonly sessions = new Map<string, McpSessionEntry<TTransport>>();
  private readonly now: () => number;
  private readonly maximumSessions: number;
  private reservations = 0;
  private closed = false;
  private readonly reservationWaiters = new Set<() => void>();
  // Transport.close() can call onclose synchronously and remove its session.
  // Serialize reservations so the callback cannot make a slot look free too early.
  private reservationGate: Promise<void> = Promise.resolve();

  /** Create a bounded session registry with an optional clock for tests. */
  constructor(options: McpSessionRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maximumSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    if (!Number.isInteger(this.maximumSessions) || this.maximumSessions < 1) {
      throw new TypeError("maxSessions must be a positive integer.");
    }
  }

  /** Number of retained sessions. */
  get size(): number {
    return this.sessions.size;
  }

  /** Configured retained-session limit. */
  get maxSessions(): number {
    return this.maximumSessions;
  }

  /** Retained sessions plus pending initialization reservations. */
  get occupancy(): number {
    return this.sessions.size + this.reservations;
  }

  /** Number of sessions with at least one active HTTP response. */
  get activeSessions(): number {
    let active = 0;
    for (const entry of this.sessions.values()) {
      if (entry.activeResponses > 0) active += 1;
    }
    return active;
  }

  /** Reserve capacity for a session before its transport is initialized. */
  async reserve(): Promise<McpSessionReservationResult<TTransport>> {
    let unlock = (): void => undefined;
    const previousReservation = this.reservationGate;
    this.reservationGate = new Promise<void>((resolve) => {
      unlock = resolve;
    });

    await previousReservation;
    try {
      if (this.closed) return { ok: false, reason: "capacity_exhausted" };
      return await this.reserveSerially();
    } finally {
      unlock();
    }
  }

  /** Evict an idle session when needed, then create one pending reservation. */
  private async reserveSerially(): Promise<McpSessionReservationResult<TTransport>> {
    let evictedSessionId: string | undefined;

    if (this.occupancy >= this.maximumSessions) {
      const failedCandidates = new Set<string>();
      let lastCloseFailure: { sessionId: string; error: unknown } | undefined;

      while (this.occupancy >= this.maximumSessions) {
        const candidate = this.oldestEvictableSession(failedCandidates);
        if (!candidate) {
          return lastCloseFailure
            ? { ok: false, reason: "close_failed", ...lastCloseFailure }
            : { ok: false, reason: "capacity_exhausted" };
        }

        const [sessionId, entry] = candidate;
        entry.closing = true;
        try {
          await entry.transport.close();
        } catch (error) {
          if (this.sessions.get(sessionId) === entry) entry.closing = false;
          failedCandidates.add(sessionId);
          lastCloseFailure = { sessionId, error };
          continue;
        }
        this.sessions.delete(sessionId);
        evictedSessionId = sessionId;
      }
    }

    if (this.closed) return { ok: false, reason: "capacity_exhausted" };

    this.reservations += 1;
    let settled = false;
    return {
      ok: true,
      reservation: {
        evictedSessionId,
        commit: async (sessionId, transport, options = {}) => {
          if (settled) throw new Error("MCP session reservation has already been settled.");
          settled = true;

          if (this.closed) {
            try {
              await transport.close();
            } finally {
              this.settleReservation();
            }
            return false;
          }

          this.settleReservation();
          if (this.sessions.size >= this.maximumSessions) {
            throw new Error("MCP session reservation exceeded the configured limit.");
          }
          this.sessions.set(sessionId, {
            transport,
            lastActivityAt: this.now(),
            activeResponses: options.active ? 1 : 0,
            closing: false,
          });
          return true;
        },
        release: () => {
          if (settled) return;
          settled = true;
          this.settleReservation();
        },
      },
    };
  }

  /** Mark one HTTP response as active for a retained session. */
  acquire(sessionId: string): TTransport | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.closing) return undefined;

    entry.activeResponses += 1;
    entry.lastActivityAt = this.now();
    return entry.transport;
  }

  /** Release one active HTTP response from a retained session. */
  release(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.activeResponses < 1) return false;

    entry.activeResponses -= 1;
    entry.lastActivityAt = this.now();
    return true;
  }

  /** Remove a session from the registry without closing its transport. */
  remove(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /** Close sessions that are idle and have no active HTTP responses. */
  async closeIdle(idleTimeoutMs: number): Promise<McpSessionCloseResult[]> {
    const cutoff = this.now() - idleTimeoutMs;
    const idleSessions: Array<{
      sessionId: string;
      entry: McpSessionEntry<TTransport>;
    }> = [];

    for (const [sessionId, entry] of this.sessions) {
      if (
        entry.closing
        || entry.activeResponses > 0
        || entry.lastActivityAt > cutoff
      ) {
        continue;
      }

      entry.closing = true;
      idleSessions.push({ sessionId, entry });
    }

    return Promise.all(
      idleSessions.map(async ({ sessionId, entry }) => {
        try {
          await entry.transport.close();
          this.sessions.delete(sessionId);
          return { sessionId };
        } catch (error) {
          if (this.sessions.get(sessionId) === entry) entry.closing = false;
          return { sessionId, error };
        }
      }),
    );
  }

  /** Stop new reservations and close every retained or initializing session. */
  async closeAll(): Promise<McpSessionCloseResult[]> {
    this.closed = true;
    await this.reservationGate;
    await this.waitForReservations();

    const sessions = Array.from(this.sessions, ([sessionId, entry]) => ({
      sessionId,
      transport: entry.transport,
    }));
    this.sessions.clear();
    return closeSessions(sessions);
  }

  /** Find the oldest idle session that has not failed during this eviction attempt. */
  private oldestEvictableSession(
    excluded: ReadonlySet<string> = new Set(),
  ): [string, McpSessionEntry<TTransport>] | undefined {
    let candidate: [string, McpSessionEntry<TTransport>] | undefined;
    for (const current of this.sessions) {
      const [sessionId, entry] = current;
      if (excluded.has(sessionId) || entry.closing || entry.activeResponses > 0) continue;
      if (!candidate || entry.lastActivityAt < candidate[1].lastActivityAt) {
        candidate = current;
      }
    }
    return candidate;
  }

  /** Decrement pending reservation count and wake shutdown when the last one settles. */
  private settleReservation(): void {
    this.reservations -= 1;
    if (this.reservations !== 0) return;
    for (const resolve of this.reservationWaiters) resolve();
    this.reservationWaiters.clear();
  }

  /** Wait until all reservations have committed or been released. */
  private waitForReservations(): Promise<void> {
    if (this.reservations === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.reservationWaiters.add(resolve);
    });
  }
}

/** Close a fixed set of transports and preserve per-session close errors. */
async function closeSessions<TTransport extends ClosableMcpTransport>(
  sessions: Array<{ sessionId: string; transport: TTransport }>,
): Promise<McpSessionCloseResult[]> {
  return Promise.all(
    sessions.map(async ({ sessionId, transport }) => {
      try {
        await transport.close();
        return { sessionId };
      } catch (error) {
        return { sessionId, error };
      }
    }),
  );
}
