export type OfflineOp = {
  type: "sendMessage";
  sessionID: string;
  text: string;
  options?: {
    model?: { providerID: string; modelID: string };
    agent?: string;
    variant?: string;
  };
};

export type QueueEntry = OfflineOp & {
  id: string;
  scope: string;
  state: "pending" | "uncertain";
};
export type QueueContext = {
  scope: string;
  send(op: OfflineOp): Promise<unknown>;
};

export class OfflineQueueError extends Error {}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function entry(value: unknown): value is QueueEntry {
  if (!object(value)) return false;
  if (
    value.type !== "sendMessage" ||
    typeof value.sessionID !== "string" ||
    !value.sessionID
  )
    return false;
  if (
    typeof value.text !== "string" ||
    !value.text ||
    typeof value.id !== "string" ||
    !value.id
  )
    return false;
  if (typeof value.scope !== "string" || !/^[a-f0-9]{64}$/.test(value.scope))
    return false;
  if (value.state !== "pending" && value.state !== "uncertain") return false;
  if (value.options === undefined) return true;
  if (!object(value.options)) return false;
  const { agent, variant, model } = value.options;
  return (
    (agent === undefined || typeof agent === "string") &&
    (variant === undefined || typeof variant === "string") &&
    (model === undefined ||
      (object(model) &&
        typeof model.providerID === "string" &&
        typeof model.modelID === "string"))
  );
}

export function createOfflineQueue(adapter: {
  read(): Promise<string | null>;
  write(raw: string): Promise<void>;
  id(): string;
  context(): Promise<QueueContext | null>;
  changed(entries: QueueEntry[]): void;
  limit?: number;
}) {
  let tail: Promise<unknown> = Promise.resolve();
  function locked<T>(run: () => Promise<T>): Promise<T> {
    const result = tail.then(run);
    tail = result.catch(() => undefined);
    return result;
  }
  async function read(): Promise<QueueEntry[]> {
    const raw = await adapter.read();
    if (raw === null) return [];
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new OfflineQueueError(
        "Offline queue is unreadable. Stored entries were preserved.",
      );
    }
    if (
      !object(value) ||
      value.version !== 1 ||
      !Array.isArray(value.entries) ||
      !value.entries.every(entry)
    ) {
      throw new OfflineQueueError(
        "Offline queue contains legacy or invalid entries. Review is required; nothing was replayed or removed.",
      );
    }
    if (
      new Set(value.entries.map((item) => item.id)).size !==
      value.entries.length
    ) {
      throw new OfflineQueueError(
        "Offline queue contains duplicate IDs. Stored entries were preserved.",
      );
    }
    return value.entries;
  }
  async function write(entries: QueueEntry[]) {
    await adapter.write(JSON.stringify({ version: 1, entries }));
    adapter.changed(entries);
  }
  async function context() {
    const value = await adapter.context();
    if (!value)
      throw new OfflineQueueError(
        "Connect to the original account and workspace to access queued messages.",
      );
    return value;
  }
  return {
    list: () =>
      locked(async () => {
        const queue = await read();
        const current = await context();
        return queue.filter((item) => item.scope === current.scope);
      }),
    enqueue: (op: OfflineOp, state: QueueEntry["state"] = "uncertain") =>
      locked(async () => {
        const current = await context();
        const queue = await read();
        if (queue.length >= (adapter.limit ?? 50))
          throw new OfflineQueueError(
            "Offline queue is full. Message was not saved; keep your draft.",
          );
        const next = {
          ...op,
          options: op.options
            ? {
                ...op.options,
                model: op.options.model ? { ...op.options.model } : undefined,
              }
            : undefined,
          id: adapter.id(),
          scope: current.scope,
          state,
        };
        if (!entry(next) || queue.some((item) => item.id === next.id))
          throw new OfflineQueueError("Invalid queued message.");
        await write([...queue, next]);
        return next.id;
      }),
    drain: (retryID?: string) =>
      locked(async () => {
        let queue = await read();
        const current = await context();
        const blocked = new Set<string>();
        let uncertain = false;
        for (const item of queue.slice()) {
          if (item.scope !== current.scope || blocked.has(item.sessionID))
            continue;
          if (item.state === "uncertain" && item.id !== retryID) {
            blocked.add(item.sessionID);
            uncertain = true;
            continue;
          }
          const latest = await adapter.context();
          if (!latest || latest.scope !== current.scope) break;
          // Persist before dispatch: a crash or failed acknowledgement must never cause automatic replay.
          queue = queue.map((value) =>
            value.id === item.id ? { ...value, state: "uncertain" } : value,
          );
          await write(queue);
          try {
            await latest.send(item);
          } catch {
            blocked.add(item.sessionID);
            uncertain = true;
            continue;
          }
          const remaining = queue.filter((value) => value.id !== item.id);
          await write(remaining);
          queue = remaining;
        }
        if (uncertain)
          throw new OfflineQueueError(
            "Queued message delivery is uncertain. Check the conversation before explicitly retrying; retry may duplicate a message.",
          );
      }),
  };
}
