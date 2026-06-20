export type RequestSerializationAccess = "exclusive" | "shared-read";

interface QueuedRequest<T = unknown> {
  access: RequestSerializationAccess;
  run: () => Promise<T> | T;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export class RequestSerializationQueues {
  private readonly queues = new Map<string, QueuedRequest[]>();
  private readonly draining = new Set<string>();

  enqueue<T>(
    key: string,
    access: RequestSerializationAccess,
    run: () => Promise<T> | T,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const queue = this.queues.get(key) ?? [];
      queue.push({ access, run, resolve, reject });
      this.queues.set(key, queue);
      this.drain(key);
    });
  }

  private drain(key: string): void {
    if (this.draining.has(key)) return;
    this.draining.add(key);

    void this.drainLoop(key).finally(() => {
      this.draining.delete(key);
      const queue = this.queues.get(key);
      if (queue && queue.length > 0) this.drain(key);
    });
  }

  private async drainLoop(key: string): Promise<void> {
    while (true) {
      const batch = this.takeNextBatch(key);
      if (batch.length === 0) return;

      await Promise.all(
        batch.map(async (request) => {
          try {
            request.resolve(await request.run());
          } catch (error) {
            request.reject(error);
          }
        }),
      );
    }
  }

  private takeNextBatch(key: string): QueuedRequest[] {
    const queue = this.queues.get(key);
    if (!queue || queue.length === 0) {
      this.queues.delete(key);
      return [];
    }

    const first = queue.shift();
    if (!first) return [];

    if (first.access === "exclusive") {
      if (queue.length === 0) this.queues.delete(key);
      return [first];
    }

    const batch = [first];
    while (queue[0]?.access === "shared-read") {
      const next = queue.shift();
      if (next) batch.push(next);
    }

    if (queue.length === 0) this.queues.delete(key);
    return batch;
  }
}

export function workspaceQueueKey(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}
