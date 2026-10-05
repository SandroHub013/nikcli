/**
 * RemoteTransport — the wire seam for the optional hub-and-spoke sync.
 *
 * `RemoteSync` orchestrates subscription, push, drain timers, and the
 * `Sync.onEmit` hook. None of that needs to know about `fetch` or
 * `EventSource` — the contract below captures the minimal capabilities
 * the orchestrator depends on:
 *
 *   - `pullBacklog(since)` — fetch missed events from the server
 *   - `subscribe(onEvent)` — receive live events; returns an unsubscribe
 *   - `push(event)` — POST a single event
 *
 * Two adapters are wired by default:
 *   - `HttpRemoteTransport` (the existing fetch + EventSource client,
 *     unchanged behaviour, isolated behind the seam)
 *   - `InMemoryRemoteTransport` (test fake)
 *
 * A second seam, `Scheduler`, abstracts `setInterval`/`setTimeout`/`Date.now`
 * so the drain loop can be tested without real timers. `InMemoryScheduler`
 * ticks deterministically when the test calls `tick()`.
 */
import { Log } from "@nikcli-ai/util/log"
import type { SyncEventRecord } from "./index"
import { EventSource as EventSourcePolyfill } from "eventsource"

const log = Log.create({ service: "sync.remote.transport" })

export type BacklogResponse = {
  events: SyncEventRecord[]
  hasMore: boolean
  nextCursor?: BacklogCursor
}

export type BacklogCursor = { seq: number; aggregate: string; id: string }
export type SubscriptionLifecycle = {
  ready(): void
  stale(error: unknown): void
  wake(): void
}

export type PushOutcome = { ok: true } | { ok: false; permanent?: boolean; error?: string }

export type RemoteTokenResolver = () => Promise<string | undefined>

export interface RemoteTransport {
  /** Fetch missed events with seq > `since`. May be called multiple
   *  times until `hasMore` is false. */
  pullBacklog(since: number, cursor?: BacklogCursor): Promise<BacklogResponse>
  /** Subscribe to live events. Return value unsubscribes. */
  subscribe(onEvent: (event: SyncEventRecord) => void | Promise<void>, lifecycle?: SubscriptionLifecycle): () => void
  /** Push a single event. The shape `PushOutcome` lets adapters signal
   *  permanent failures (e.g. HTTP 401) so the outbox stops retrying. */
  push(event: SyncEventRecord): Promise<PushOutcome>
  /** Close the connection and any timers. */
  close(): void
}

export interface Scheduler {
  /** Schedule a recurring task; returns a handle for `clear`. */
  interval(cb: () => void, periodMs: number): SchedulerHandle
  /** One-shot timer. */
  timeout(cb: () => void, delayMs: number): SchedulerHandle
  /** "Now" in test-friendly time. Defaults to `Date.now`. */
  now(): number
}

export type SchedulerHandle = {
  clear(): void
}

function resolveEventSource(eventSourceImpl?: typeof EventSource): typeof EventSource {
  if (eventSourceImpl) return eventSourceImpl
  const native = (globalThis as { EventSource?: typeof EventSource }).EventSource
  if (native) return native
  return EventSourcePolyfill as unknown as typeof EventSource
}

// ---------- HTTP + EventSource adapter (default) ----------

export type HttpRemoteTransportOptions = {
  url: string
  token: string
  resolveToken?: RemoteTokenResolver
  projectID: string
  onError?: (error: unknown) => void
  fetchImpl?: typeof fetch
  eventSourceImpl?: typeof EventSource
  /** First reconnect delay after a malformed frame. Doubles per consecutive
   *  failure up to `reopenCapMs`, and resets on a real `ready`. */
  reopenDelayMs?: number
}

export function createHttpRemoteTransport(opts: HttpRemoteTransportOptions): RemoteTransport {
  const fetchImpl = opts.fetchImpl ?? fetch
  const EventSourceImpl = resolveEventSource(opts.eventSourceImpl)

  const base = opts.url.replace(/\/$/, "")
  let token = opts.token
  let refreshingToken: Promise<boolean> | undefined
  let source: EventSource | undefined
  const reopenCapMs = 30_000
  const baseReopenDelayMs = Math.max(0, opts.reopenDelayMs ?? 1_000)
  let reopenDelayMs = baseReopenDelayMs
  let reopenTimer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const cancellation = new AbortController()
  const lifecycles = new Set<SubscriptionLifecycle>()
  const subscribers = new Set<(event: SyncEventRecord) => void | Promise<void>>()

  async function refreshToken(failedToken: string): Promise<boolean> {
    if (token !== failedToken) return true
    if (!opts.resolveToken) return false
    if (!refreshingToken) {
      refreshingToken = opts
        .resolveToken()
        .then((next) => {
          if (!next || next === failedToken) return false
          if (closed) return false
          token = next
          return true
        })
        .finally(() => {
          refreshingToken = undefined
        })
    }
    return refreshingToken
  }

  function withToken(headers: HeadersInit | undefined, value: string): Headers {
    const next = new Headers(headers)
    next.set("authorization", `Bearer ${value}`)
    return next
  }

  async function fetchWithToken(input: string, init: RequestInit = {}): Promise<Response> {
    if (closed) throw new Error("transport closed")
    init = {
      ...init,
      signal: AbortSignal.any([cancellation.signal, init.signal ?? AbortSignal.timeout(30_000)]),
    }
    const failedToken = token
    const first = await fetchImpl(input, {
      ...init,
      headers: withToken(init.headers, failedToken),
    })
    if (first.status !== 401 || !(await refreshToken(failedToken))) return first
    if (closed) throw new Error("transport closed")
    return fetchImpl(input, {
      ...init,
      headers: withToken(init.headers, token),
    })
  }

  function fanout(event: SyncEventRecord) {
    for (const sub of subscribers) {
      Promise.resolve(sub(event)).catch((error) => log.warn("remote subscribe handler failed", { error }))
    }
  }

  async function pullBacklog(since: number, cursor?: BacklogCursor): Promise<BacklogResponse> {
    const url = new URL(`${base}/sync/outbox`)
    url.searchParams.set("projectID", opts.projectID)
    url.searchParams.set("since", String(since))
    if (cursor) {
      url.searchParams.set("since", String(cursor.seq))
      url.searchParams.set("afterAggregate", cursor.aggregate)
      url.searchParams.set("afterID", cursor.id)
    }
    const res = await fetchWithToken(url.toString(), {
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`backlog HTTP ${res.status}`)
    return (await res.json()) as BacklogResponse
  }

  function openSource(): void {
    if (closed) return
    const streamUrl = new URL(`${base}/sync/stream`)
    streamUrl.searchParams.set("projectID", opts.projectID)
    streamUrl.searchParams.set("token", token)
    streamUrl.searchParams.set("readiness", "1")
    const sourceToken = token
    const nextSource = new EventSourceImpl!(streamUrl.toString())
    source = nextSource
    nextSource.addEventListener("ready", () => {
      if (closed || source !== nextSource) return
      // A stream that reached `ready` is trusted again, so the next malformed
      // frame starts from the base delay rather than the escalated one.
      reopenDelayMs = baseReopenDelayMs
      for (const lifecycle of lifecycles) lifecycle.ready()
    })
    // The server emits `event: sync` on the stream
    // (server/routes/sync.ts), so listen for that event name.
    nextSource.addEventListener("sync", (e: MessageEvent) => {
      try {
        if (closed || source !== nextSource) return
        const event = JSON.parse(e.data)
        if (event.type === "sync.received") {
          for (const lifecycle of lifecycles) lifecycle.wake()
          return
        }
        if (
          event.projectId !== opts.projectID ||
          typeof event.id !== "string" ||
          typeof event.aggregate !== "string" ||
          !Number.isSafeInteger(event.seq) ||
          event.seq < 1
        ) {
          throw new Error("invalid remote sync event")
        }
        fanout(event)
      } catch (error) {
        nextSource.close()
        source = undefined
        opts.onError?.(error)
        for (const lifecycle of lifecycles) lifecycle.stale(error)
        scheduleReopen()
      }
    })
    nextSource.addEventListener("error", (event: Event) => {
      if (closed || source !== nextSource) return
      opts.onError?.(event)
      for (const lifecycle of lifecycles) lifecycle.stale(event)
      const code = (event as Event & { code?: unknown }).code
      if (code !== 401 || source !== nextSource) return
      nextSource.close()
      source = undefined
      void refreshToken(sourceToken)
        .then((changed) => {
          if (!closed && changed && subscribers.size > 0 && !source) openSource()
        })
        .catch((error) => opts.onError?.(error))
    })
  }

  /**
   * Replace a stream that produced a frame the client could not parse.
   *
   * A malformed frame means the connection cannot be trusted, so readiness is
   * invalidated and the replacement is opened after a backoff rather than
   * immediately: a hub that keeps emitting malformed frames must not be met
   * with a hot reconnect loop. Malformed input stays recoverable — the stream
   * comes back and the next `ready` re-fences the consumer.
   */
  function scheduleReopen(): void {
    if (closed || source || reopenTimer) return
    if (subscribers.size === 0) return
    const delay = reopenDelayMs
    reopenDelayMs = Math.min(reopenDelayMs * 2, reopenCapMs)
    reopenTimer = setTimeout(() => {
      reopenTimer = undefined
      if (closed || source || subscribers.size === 0) return
      openSource()
    }, delay)
  }

  function subscribe(
    onEvent: (event: SyncEventRecord) => void | Promise<void>,
    lifecycle?: SubscriptionLifecycle,
  ): () => void {
    if (closed) throw new Error("transport closed")
    subscribers.add(onEvent)
    if (lifecycle) lifecycles.add(lifecycle)
    if (!source) openSource()
    return () => {
      subscribers.delete(onEvent)
      if (lifecycle) lifecycles.delete(lifecycle)
      if (subscribers.size === 0 && source) {
        source.close()
        source = undefined
      }
    }
  }

  async function push(event: SyncEventRecord): Promise<PushOutcome> {
    try {
      const res = await fetchWithToken(`${base}/sync/event`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ event, projectID: opts.projectID }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) {
        return {
          ok: false,
          permanent: res.status === 401 || res.status === 403,
          error: `HTTP ${res.status}`,
        }
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: String(error) }
    }
  }

  function close(): void {
    closed = true
    cancellation.abort()
    if (reopenTimer) {
      clearTimeout(reopenTimer)
      reopenTimer = undefined
    }
    if (source) {
      source.close()
      source = undefined
    }
    subscribers.clear()
    lifecycles.clear()
  }

  return { pullBacklog, subscribe, push, close }
}

// ---------- Real scheduler ----------

export const realScheduler: Scheduler = {
  interval(cb, periodMs) {
    const id = setInterval(cb, periodMs)
    return { clear: () => clearInterval(id) }
  },
  timeout(cb, delayMs) {
    const id = setTimeout(cb, delayMs)
    return { clear: () => clearTimeout(id) }
  },
  now() {
    return Date.now()
  },
}

// ---------- In-memory scheduler (test) ----------

export type InMemorySchedulerOptions = {
  initialNow?: number
}

export function createInMemoryScheduler(opts: InMemorySchedulerOptions = {}): Scheduler & {
  tick(ms: number): void
  pendingCount(): number
} {
  let now = opts.initialNow ?? 0
  type Pending = {
    id: number
    at: number
    cb: () => void
    periodicMs?: number
  }
  const tasks = new Map<number, Pending>()
  let nextId = 1

  // Track every distinct callback that was ever scheduled so clear()
  // can sweep pending AND already-rescheduled tasks of that callback.
  const cbIds = new WeakMap<() => void, Set<number>>()
  function track(cb: () => void, id: number) {
    let set = cbIds.get(cb)
    if (!set) {
      set = new Set()
      cbIds.set(cb, set)
    }
    set.add(id)
  }
  function untrackAll(cb: () => void) {
    const set = cbIds.get(cb)
    if (!set) return
    for (const id of set) tasks.delete(id)
    cbIds.delete(cb)
  }
  function schedule(cb: () => void, delayMs: number, periodicMs?: number) {
    const id = nextId++
    tasks.set(id, { id, at: now + delayMs, cb, periodicMs })
    return id
  }
  function tick(ms: number) {
    const end = now + ms
    for (;;) {
      const due: Pending[] = []
      for (const t of tasks.values()) if (t.at <= end) due.push(t)
      if (due.length === 0) break
      due.sort((a, b) => a.at - b.at)
      const next = due[0]
      tasks.delete(next.id)
      now = next.at
      try {
        next.cb()
      } catch (error) {
        log.warn("scheduled task threw", { error })
      }
      if (next.periodicMs !== undefined) {
        const id = nextId++
        tasks.set(id, {
          id,
          at: next.at + next.periodicMs,
          cb: next.cb,
          periodicMs: next.periodicMs,
        })
        // Re-register the rescheduled successor with the same callback
        // tracker so `clear()` sweeps it too.
        const set = cbIds.get(next.cb)
        if (set) set.add(id)
      }
    }
    now = end
  }
  return {
    interval(cb, periodMs) {
      const id = schedule(cb, periodMs, periodMs)
      track(cb, id)
      return { clear: () => untrackAll(cb) }
    },
    timeout(cb, delayMs) {
      const id = schedule(cb, delayMs)
      track(cb, id)
      return { clear: () => untrackAll(cb) }
    },
    now() {
      return now
    },
    tick,
    pendingCount: () => tasks.size,
  }
}

// ---------- In-memory transport (test) ----------

export function createInMemoryRemoteTransport(): RemoteTransport & {
  /** Program events the transport will deliver to subscribers and/or
   *  the backlog reader. */
  enqueue(event: SyncEventRecord): void
  /** Read all events the orchestrator tried to push. */
  pushed: SyncEventRecord[]
  /** Override the next `push` outcome (e.g. simulate 401/503). */
  setNextPush(outcome: PushOutcome): void
  reset(): void
} {
  const queue: SyncEventRecord[] = []
  const pushed: SyncEventRecord[] = []
  const subscribers = new Set<(event: SyncEventRecord) => void | Promise<void>>()
  let nextPush: PushOutcome | undefined
  let since = 0

  return {
    async pullBacklog(s: number) {
      const filtered = queue.filter((e) => e.seq > s).sort((a, b) => a.seq - b.seq)
      since = Math.max(since, ...filtered.map((e) => e.seq))
      return { events: filtered, hasMore: false }
    },
    subscribe(onEvent, lifecycle) {
      subscribers.add(onEvent)
      lifecycle?.ready()
      return () => subscribers.delete(onEvent)
    },
    async push(event) {
      if (nextPush) {
        const outcome = nextPush
        nextPush = undefined
        return outcome
      }
      pushed.push(event)
      return { ok: true }
    },
    close() {
      subscribers.clear()
    },
    enqueue(event: SyncEventRecord) {
      queue.push(event)
      for (const sub of subscribers) Promise.resolve(sub(event))
    },
    setNextPush(outcome: PushOutcome) {
      nextPush = outcome
    },
    reset() {
      queue.length = 0
      pushed.length = 0
      nextPush = undefined
      subscribers.clear()
      since = 0
    },
    pushed,
  } as ReturnType<typeof createInMemoryRemoteTransport>
}
