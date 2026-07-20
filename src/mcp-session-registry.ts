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
}

export interface RegistryOptions {
  idleMs: number;
  sweepMs: number;
  maxSessions: number;
  onSweep?: (closed: number, evicted: number) => void;
  onSessionClose?: (id: string, error?: Error) => void;
}

export class McpSessionRegistry {
  private readonly sessions = new Map<string, TrackedSession>();
  private readonly options: RegistryOptions;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private closePromise: Promise<void> | null = null;
  private totalClosed = 0;
  private totalEvicted = 0;
  private lastCloseError: string | null = null;

  constructor(options: RegistryOptions) {
    this.options = options;
  }

  /** Start the periodic sweep timer. */
  startSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
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

  /**
   * Register a new session. If at capacity, evict the oldest idle session to make room.
   * Returns false if the registry is at capacity and no idle sessions can be evicted.
   * The new session is NOT added to the registry if false is returned.
   */
  register(id: string, transport: StreamableHTTPServerTransport): boolean {
    // If at capacity, evict the oldest idle session to free a slot.
    if (this.sessions.size >= this.options.maxSessions) {
      const eligible: TrackedSession[] = [];
      for (const s of this.sessions.values()) {
        if (s.inFlight === 0) eligible.push(s);
      }
      if (eligible.length === 0) {
        return false; // No evictable sessions — reject.
      }
      eligible.sort((a, b) => a.lastActivity - b.lastActivity);
      const toEvict = eligible[0]!;
      this.sessions.delete(toEvict.id);
      this.totalEvicted++;
      this.closeTransport(toEvict).catch(() => {});
    }
    this.sessions.set(id, {
      id,
      transport,
      lastActivity: Date.now(),
      inFlight: 0,
    });
    return true;
  }

  /** Whether the registry is at capacity with no evictable idle sessions. */
  get atCapacity(): boolean {
    if (this.sessions.size < this.options.maxSessions) return false;
    for (const s of this.sessions.values()) {
      if (s.inFlight === 0) return false;
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

  /** Current session count. */
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
      if (s.inFlight > 0) continue;
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
   * Evict oldest idle sessions when maxSessions is exceeded.
   * Only sessions with inFlight === 0 are eligible.
   */
  private evictOldestIdle(): void {
    const eligible: TrackedSession[] = [];
    for (const s of this.sessions.values()) {
      if (s.inFlight === 0) eligible.push(s);
    }
    eligible.sort((a, b) => a.lastActivity - b.lastActivity);
    while (this.sessions.size > this.options.maxSessions && eligible.length > 0) {
      const s = eligible.shift()!;
      this.sessions.delete(s.id);
      this.totalEvicted++;
      this.closeTransport(s).catch(() => {});
    }
  }

  /**
   * Close a single session transport. Idempotent per session.
   * Logs transport_close at most once. Failures are recorded but not thrown.
   */
  private async closeTransport(s: TrackedSession): Promise<void> {
    if (s.closeStarted) return;
    s.closeStarted = true;
    try {
      await s.transport.close();
      s.closed = true;
      this.options.onSessionClose?.(s.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastCloseError = `Session ${s.id} transport.close failed: ${msg}`;
      this.options.onSessionClose?.(s.id, err instanceof Error ? err : new Error(msg));
    }
  }

  /**
   * Close ALL sessions. Returns a shared Promise on repeated calls.
   * One transport failure does NOT abort other cleanup.
   */
  closeAll(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.doCloseAll();
    return this.closePromise;
  }

  private async doCloseAll(): Promise<void> {
    this.stopSweep();
    const all = [...this.sessions.values()];
    this.sessions.clear();
    // Close all in parallel; each failure is handled inside closeTransport.
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

    // 2. Close all MCP session transports (parallel, failure-tolerant)
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(all.map((s) => this.closeTransport(s)));
    this.totalClosed += all.length;

    // 3. Drain HTTP server
    if (opts.httpServer) {
      await this.shutdownHttpServer(opts.httpServer, opts.drainTimeoutMs ?? 10_000);
    }

    // 4. Application cleanup
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
        // Force-close remaining connections after timeout
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
    return {
      activeSessions: this.sessions.size,
      totalClosed: this.totalClosed,
      totalEvicted: this.totalEvicted,
      idleMs: this.options.idleMs,
      sweepMs: this.options.sweepMs,
      maxSessions: this.options.maxSessions,
      lastError: this.lastCloseError,
    };
  }
}
