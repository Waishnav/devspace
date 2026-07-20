/**
 * McpSessionRegistry — PR #71 formal session lifecycle management.
 *
 * Responsibilities:
 *  - Track every MCP session with lastActivity and inFlight counters.
 *  - closeIdle: remove sessions idle longer than idleMs (but never if inFlight > 0).
 *  - closeAll: wait for every session transport to close; one failure does not abort others.
 *  - server-shutdown: drain HTTP connections, wait for app cleanup, idempotent close.
 *
 * Design rules enforced:
 *  - After removing a session from the registry, transport.close() is awaited.
 *  - If transport.close() fails, the session is NOT put back.
 *  - closeAll returns a single shared Promise<void> on repeated calls.
 *  - server shutdown waits for both HTTP server close and application cleanup.
 *  - transport_close log emitted at most once per session.
 *  - One transport failure never aborts other session cleanup.
 *  - Atomic reservation prevents concurrent initialize from exceeding maxSessions.
 */

import type { Server as HttpServer } from "node:http";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export interface TrackedSession {
  id: string;
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
  inFlight: number;
  closeStarted?: boolean;
  closed?: boolean;
  /** True while the initialize handshake is in progress (initialize sent, notifications/initialized not yet received). */
  initializing?: boolean;
  /** Timestamp the session was committed (initialize response sent). */
  initializedAt?: number;
  /** Deadline after which a stuck initializing session can be force-cleaned. */
  handshakeDeadline?: number;
}

export interface RegistryOptions {
  idleMs: number;
  sweepMs: number;
  maxSessions: number;
  /** Max time (ms) a session can stay in initializing state before force-cleanup. Default 30000. */
  handshakeTimeoutMs?: number;
  onSweep?: (closed: number, evicted: number) => void;
  onSessionClose?: (id: string, error?: Error) => void;
}

/**
 * A reservation holds a capacity slot during session initialization.
 * It must be either committed (turned into a real session) or released.
 */
export interface SessionReservation {
  /** Unique token to prevent double-commit / double-release. */
  readonly token: string;
  /** Timestamp the reservation was created. */
  readonly createdAt: number;
  /** Whether this reservation has been committed or released. */
  settled: boolean;
}

export class McpSessionRegistry {
  private readonly sessions = new Map<string, TrackedSession>();
  private readonly options: RegistryOptions;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private closePromise: Promise<void> | null = null;
  private totalClosed = 0;
  private totalEvicted = 0;
  private totalReservations = 0;
  private totalReservationsReleased = 0;
  private lastCloseError: string | null = null;

  /**
   * Active reservations for in-flight initialize requests.
   * Capacity = sessions.size + reservations.size.
   * At most maxSessions reservations + sessions combined.
   */
  private readonly reservations = new Set<SessionReservation>();

  /** Test-only: session IDs that should fail when closeTransport is called. */
  private readonly closeFailureInjection = new Set<string>();

  constructor(options: RegistryOptions) {
    this.options = options;
  }

  /** Test-only: inject a close failure for a specific session. */
  injectCloseFailure(id: string): void {
    this.closeFailureInjection.add(id);
  }

  /** Start the periodic sweep timer. */
  startSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      this.closeStaleHandshakes();
      this.closeIdle().catch(() => {});
    }, this.options.sweepMs);
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }

  /** Stop the periodic sweep timer. */
  stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  // ─── Atomic Reservation API ───────────────────────────────────────────

  /**
   * Total occupied capacity: registered sessions + pending reservations.
   * This is the value capacity checks must use.
   */
  get occupiedCapacity(): number {
    return this.sessions.size + this.reservations.size;
  }

  /** Number of pending (unsettled) reservations. */
  get pendingReservations(): number {
    return this.reservations.size;
  }

  /**
   * Atomically reserve a capacity slot for a new session.
   *
   * - If there is room (sessions + reservations < maxSessions), create a reservation.
   * - If at capacity but idle sessions exist, evict the oldest idle session, then reserve.
   * - If at capacity and all sessions are busy (inFlight > 0), return undefined.
   *
   * This method is synchronous and must be called BEFORE creating the transport.
   */
  tryReserveSlot(): SessionReservation | undefined {
    // Capacity includes both sessions and pending reservations.
    if (this.occupiedCapacity >= this.options.maxSessions) {
      // At capacity — try to evict an idle, fully-handshaked session to make room.
      // Sessions that are initializing or have inFlight > 0 are protected.
      const eligible: TrackedSession[] = [];
      for (const s of this.sessions.values()) {
        if (s.inFlight === 0 && !s.initializing) eligible.push(s);
      }
      if (eligible.length === 0) {
        return undefined; // No evictable sessions — reject.
      }
      eligible.sort((a, b) => a.lastActivity - b.lastActivity);
      const toEvict = eligible[0]!;
      this.sessions.delete(toEvict.id);
      this.totalEvicted++;
      this.closeTransport(toEvict).catch(() => {});
    }

    const reservation: SessionReservation = {
      token: `res-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      createdAt: Date.now(),
      settled: false,
    };
    this.reservations.add(reservation);
    this.totalReservations++;
    return reservation;
  }

  /**
   * Commit a reservation into a fully registered session.
   * The reservation is removed from the pending set.
   * Returns true on success, false if the reservation was already settled
   * (double-commit guard).
   */
  commitReservation(
    reservation: SessionReservation,
    sessionId: string,
    transport: StreamableHTTPServerTransport,
  ): boolean {
    if (reservation.settled) {
      return false; // Double-commit guard.
    }
    reservation.settled = true;
    this.reservations.delete(reservation);

    // Defensive: if somehow over capacity (shouldn't happen with reservations),
    // log the error but still register to avoid losing the session.
    if (this.sessions.size >= this.options.maxSessions) {
      // This is an internal state error — reservations should have prevented this.
      console.error(
        `[McpSessionRegistry] INTERNAL ERROR: commitReservation called at capacity ` +
          `(${this.sessions.size}/${this.options.maxSessions}). ` +
          `Reservation ${reservation.token} may have been double-counted.`,
      );
    }

    const now = Date.now();
    const handshakeTimeout = this.options.handshakeTimeoutMs ?? 30_000;
    this.sessions.set(sessionId, {
      id: sessionId,
      transport,
      lastActivity: now,
      inFlight: 1, // initialize request is still in flight
      initializing: true,
      initializedAt: now,
      handshakeDeadline: now + handshakeTimeout,
    });
    return true;
  }

  /**
   * Complete the initialization handshake for a session.
   * Called after notifications/initialized is received.
   * Sets initializing=false and refreshes lastActivity.
   * Returns true on success, false if session not found or not initializing.
   */
  completeHandshake(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s || !s.initializing) return false;
    s.initializing = false;
    s.handshakeDeadline = undefined;
    s.lastActivity = Date.now();
    return true;
  }

  /**
   * Release a reservation without committing (e.g., initialize failed).
   * Safe to call multiple times — second call is a no-op.
   */
  releaseReservation(reservation: SessionReservation): void {
    if (reservation.settled) {
      return; // Already committed or released — no-op.
    }
    reservation.settled = true;
    this.reservations.delete(reservation);
    this.totalReservationsReleased++;
  }

  // ─── Legacy Register (defensive only) ─────────────────────────────────

  /**
   * Register a new session directly (legacy path).
   *
   * With the reservation API, normal initialize flow should use
   * tryReserveSlot → commitReservation. This method is kept as a
   * defensive fallback. If it fails, it indicates an internal state error.
   *
   * Returns false if at capacity with no evictable idle sessions.
   */
  register(id: string, transport: StreamableHTTPServerTransport): boolean {
    if (this.occupiedCapacity >= this.options.maxSessions) {
      const eligible: TrackedSession[] = [];
      for (const s of this.sessions.values()) {
        if (s.inFlight === 0 && !s.initializing) eligible.push(s);
      }
      if (eligible.length === 0) {
        return false;
      }
      eligible.sort((a, b) => a.lastActivity - b.lastActivity);
      const toEvict = eligible[0]!;
      this.sessions.delete(toEvict.id);
      this.totalEvicted++;
      this.closeTransport(toEvict).catch(() => {});
    }
    const now = Date.now();
    const handshakeTimeout = this.options.handshakeTimeoutMs ?? 30_000;
    this.sessions.set(id, {
      id,
      transport,
      lastActivity: now,
      inFlight: 0,
      initializing: false,
      initializedAt: now,
      handshakeDeadline: undefined,
    });
    return true;
  }

  /** Whether the registry is at capacity with no evictable idle sessions. */
  get atCapacity(): boolean {
    if (this.occupiedCapacity < this.options.maxSessions) return false;
    // At capacity — check if any session is idle AND fully handshaked.
    for (const s of this.sessions.values()) {
      if (s.inFlight === 0 && !s.initializing) return false;
    }
    return true;
  }

  /** Mark a session as active (request started). */
  markActive(id: string): TrackedSession | undefined {
    const s = this.sessions.get(id);
    if (s) {
      s.lastActivity = Date.now();
      s.inFlight++;
    }
    return s;
  }

  /** Mark a request complete on a session. */
  markIdle(id: string): void {
    const s = this.sessions.get(id);
    if (s && s.inFlight > 0) {
      s.inFlight--;
    }
  }

  /** Remove a single session from the registry (does not close transport). */
  forget(id: string): TrackedSession | undefined {
    const s = this.sessions.get(id);
    if (s) this.sessions.delete(id);
    return s;
  }

  /** Get a session by id. */
  get(id: string): TrackedSession | undefined {
    return this.sessions.get(id);
  }

  /** Current registered session count (excludes reservations). */
  get size(): number {
    return this.sessions.size;
  }

  /** Total sessions closed since start. */
  get closedCount(): number {
    return this.totalClosed;
  }

  /** Total sessions evicted due to cap. */
  get evictedCount(): number {
    return this.totalEvicted;
  }

  /** Total reservations created since start. */
  get reservationCount(): number {
    return this.totalReservations;
  }

  /** Last close error, if any. */
  get lastError(): string | null {
    return this.lastCloseError;
  }

  /**
   * Close idle sessions (idleMs elapsed AND inFlight === 0).
   * Returns counts of closed and evicted sessions.
   */
  async closeIdle(): Promise<{ closed: number; evicted: number }> {
    const now = Date.now();
    const toClose: TrackedSession[] = [];
    for (const s of this.sessions.values()) {
      // Clean up stale handshakes: initializing sessions past their deadline with inFlight=0.
      if (s.initializing && s.inFlight === 0 && s.handshakeDeadline && now >= s.handshakeDeadline) {
        toClose.push(s);
        continue;
      }
      // Normal idle cleanup: skip sessions with inFlight > 0 or still initializing.
      if (s.inFlight > 0 || s.initializing) continue;
      if (now - s.lastActivity >= this.options.idleMs) {
        toClose.push(s);
      }
    }
    let closed = 0;
    for (const s of toClose) {
      this.sessions.delete(s.id);
      await this.closeTransport(s);
      closed++;
    }
    if (closed > 0) {
      this.totalClosed += closed;
      this.options.onSweep?.(closed, 0);
    }
    return { closed, evicted: 0 };
  }

  /**
   * Force-close sessions stuck in initializing state past their handshake deadline.
   * This handles cases where the client disconnected after initialize but before
   * sending notifications/initialized, and inFlight has returned to 0.
   * Returns the number of sessions cleaned up.
   */
  closeStaleHandshakes(): number {
    const now = Date.now();
    let cleaned = 0;
    for (const s of this.sessions.values()) {
      if (s.initializing && s.inFlight === 0 && s.handshakeDeadline && now >= s.handshakeDeadline) {
        this.sessions.delete(s.id);
        this.closeTransport(s).catch(() => {});
        this.totalClosed++;
        cleaned++;
      }
    }
    return cleaned;
  }

  /**
   * Close a single session transport. Idempotent per session.
   * Logs transport_close at most once. Failures are recorded but not thrown.
   */
  private async closeTransport(s: TrackedSession): Promise<void> {
    if (s.closeStarted) return;
    s.closeStarted = true;
    try {
      if (this.closeFailureInjection.has(s.id)) {
        throw new Error(`Injected close failure for session ${s.id}`);
      }
      await s.transport.close();
      s.closed = true;
      this.options.onSessionClose?.(s.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastCloseError = `Session ${s.id} transport.close failed: ${msg}`;
      this.options.onSessionClose?.(s.id, err instanceof Error ? err : new Error(msg));
    } finally {
      this.closeFailureInjection.delete(s.id);
    }
  }

  /**
   * Close ALL sessions and release all reservations. Returns a shared Promise on repeated calls.
   * One transport failure does NOT abort other cleanup.
   */
  closeAll(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.doCloseAll();
    return this.closePromise;
  }

  private async doCloseAll(): Promise<void> {
    this.stopSweep();
    // Release all pending reservations.
    for (const r of this.reservations) {
      r.settled = true;
    }
    this.reservations.clear();
    // Close all sessions.
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(all.map((s) => this.closeTransport(s)));
    this.totalClosed += all.length;
  }

  /**
   * Full server shutdown: stop sweep, close all sessions, drain HTTP server,
   * and wait for application cleanup.
   * Idempotent — returns the same Promise on repeated calls.
   */
  shutdown(opts: {
    httpServer?: HttpServer | null;
    appCleanup?: () => Promise<void>;
    drainTimeoutMs?: number;
  }): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.doShutdown(opts);
    return this.closePromise;
  }

  private async doShutdown(opts: {
    httpServer?: HttpServer | null;
    appCleanup?: () => Promise<void>;
    drainTimeoutMs?: number;
  }): Promise<void> {
    // 1. Stop accepting new sweep work
    this.stopSweep();

    // 2. Release all pending reservations
    for (const r of this.reservations) {
      r.settled = true;
    }
    this.reservations.clear();

    // 3. Close all MCP session transports (parallel, failure-tolerant)
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(all.map((s) => this.closeTransport(s)));
    this.totalClosed += all.length;

    // 4. Drain HTTP server
    if (opts.httpServer) {
      await this.shutdownHttpServer(opts.httpServer, opts.drainTimeoutMs ?? 10_000);
    }

    // 5. Application cleanup
    if (opts.appCleanup) {
      try {
        await opts.appCleanup();
      } catch (err) {
        this.lastCloseError = `App cleanup failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }

  /** Close an HTTP server with a drain timeout. */
  private shutdownHttpServer(server: HttpServer, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const timer = setTimeout(() => {
        server.closeAllConnections?.();
        finish();
      }, timeoutMs);
      if (timer.unref) timer.unref();
      server.close((err) => {
        clearTimeout(timer);
        if (err && err.message !== "Server is not running") {
          this.lastCloseError = `HTTP server close error: ${err.message}`;
        }
        finish();
      });
    });
  }

  /** Diagnostic snapshot for runtime diagnostics (PR #69). */
  snapshot() {
    let initializingCount = 0;
    for (const s of this.sessions.values()) {
      if (s.initializing) initializingCount++;
    }
    return {
      activeSessions: this.sessions.size,
      pendingReservations: this.reservations.size,
      occupiedCapacity: this.occupiedCapacity,
      initializingSessions: initializingCount,
      totalClosed: this.totalClosed,
      totalEvicted: this.totalEvicted,
      totalReservations: this.totalReservations,
      totalReservationsReleased: this.totalReservationsReleased,
      idleMs: this.options.idleMs,
      sweepMs: this.options.sweepMs,
      maxSessions: this.options.maxSessions,
      handshakeTimeoutMs: this.options.handshakeTimeoutMs ?? 30_000,
      lastError: this.lastCloseError,
    };
  }
}
