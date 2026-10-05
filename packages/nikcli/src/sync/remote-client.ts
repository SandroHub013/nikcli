/**
 * RemoteSyncClient — HTTPS client for the optional remote hub server
 * (e.g. https://s.nikcli-ai.dev). Used by the local CLI to push events
 * it produced and to subscribe to events the remote server produced
 * for the same project.
 *
 * The wire protocol mirrors the in-process one: a `SyncEventRecord`
 * crosses the wire as JSON. The client uses `fetch` for push and
 * `EventSource` for subscribe; both are part of the Web standard so
 * no extra runtime dependencies.
 *
 * Reconnection is handled with exponential backoff (cap 30s). On
 * reconnect, the client asks the server for events with `seq > since`
 * via the `/sync/outbox?since=…` catch-up endpoint to avoid gaps.
 *
 * **Cursors are per aggregate, and the `since` it sends is derived from all of
 * them.** `specs/effect-tui/15-sync-snapshots-watermarks.md` requirement 7:
 * "each consumer maintains a per-aggregate cursor `(aggregateID, watermark)`.
 * Global cursors are **derived** from the per-aggregate cursors; they are not
 * authoritative." Two facts make that necessary rather than tidy:
 *
 *   - `seq` is handed out **per aggregate** — `Sync.reserveSeqAndAppend` reads
 *     its counter with `and(eq(projectId), eq(aggregate))`, so each aggregate
 *     counts from 1 and two aggregates' `seq` values are not comparable.
 *   - `/sync/outbox` answers `projectId = ? AND seq > since`. It grew an
 *     optional `aggregate` predicate (2026-10-02), but the replay below does
 *     not use it — see `catchUp` for why, and for what that costs.
 *
 * A single cursor — the maximum `seq` seen anywhere — is therefore a cursor for
 * a stream that does not exist. A merely *less active* aggregate has its events
 * skipped forever: with A at seq 60 and B at seq 5, a reconnect asking
 * `since=60` never sees B's 6, 7, 8, and the loss is silent. Even the minimum
 * known cursor skips unknown aggregates. Each replay starts at zero and uses
 * composite page positions; per-aggregate cursors deduplicate applied events.
 */
import { Log } from "@nikcli-ai/util/log"
import type { SyncEventRecord } from "./index"
import type { BacklogCursor, BacklogResponse } from "./transport"

const log = Log.create({ service: "sync.remote-client" })

export type RemoteSyncClientOptions = {
  url: string
  token: string
  projectID: string
  onEvent: (event: SyncEventRecord) => void | Promise<void>
  onError?: (error: unknown) => void
}

export class RemoteSyncClient {
  private source: EventSource | undefined
  /**
   * Per-aggregate resume positions, keyed by `aggregate`.
   *
   * EOT-15 requirement 7. A single shared `lastSeq` silently dropped every
   * event of any aggregate that was less active than the busiest one. The
   * aggregate predicate that could correct it exists now; see `catchUp` for
   * why a consumer still cannot lean on it.
   */
  private readonly cursors = new Map<string, number>()
  private stopped = false
  private backoffMs = 1000
  private readonly backoffCapMs = 30_000
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private ingestQueue: Promise<void> = Promise.resolve()

  constructor(private readonly opts: RemoteSyncClientOptions) {}

  /** The position this client has consumed for one aggregate. */
  private cursorFor(aggregate: string) {
    return this.cursors.get(aggregate) ?? 0
  }

  /** Serialize delivery so failed callbacks cannot be overtaken by later events. */
  private ingest(event: SyncEventRecord) {
    const delivery = this.ingestQueue.then(async () => {
      if (event.seq <= this.cursorFor(event.aggregate)) return
      await this.opts.onEvent(event)
      this.cursors.set(event.aggregate, event.seq)
    })
    this.ingestQueue = delivery
    return delivery
  }

  async start(): Promise<void> {
    this.stopped = false
    // Step 1: replay and deduplicate per aggregate
    await this.catchUp().catch((error) => {
      log.warn("initial catch-up failed", { error })
    })
    // Step 2: subscribe to live stream
    this.subscribe()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    if (this.source) {
      this.source.close()
      this.source = undefined
    }
  }

  /**
   * Push a single event to the remote server. Returns true on success,
   * false on transient failure (the caller should leave the event in
   * the outbox for retry).
   */
  async push(event: SyncEventRecord): Promise<boolean> {
    const url = `${this.opts.url.replace(/\/$/, "")}/sync/event`
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.opts.token}`,
        },
        body: JSON.stringify({ event, projectID: this.opts.projectID }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) {
        log.warn("push failed", {
          status: res.status,
          event: event.id,
        })
        return false
      }
      return true
    } catch (error) {
      log.warn("push error", { error, event: event.id })
      return false
    }
  }

  /**
   * Replay from zero so previously unknown aggregates cannot be skipped.
   *
   * Public because it is the seam the regression test drives: the reconnect path
   * also resubscribes, and an `EventSource` cannot be exercised headlessly.
   *
   * This deliberately does **not** send the `aggregate` predicate the endpoint
   * accepts. The set of aggregates is not knowable in advance — that is the
   * whole reason the replay starts at zero — so scoping a page to one of them
   * can only ever return the aggregates already held in `cursors`, and an
   * aggregate that first spoke while this client was disconnected would be
   * missing from the list and therefore from the replay. That is the original
   * silent loss, reintroduced by the obvious-looking optimisation.
   *
   * So the predicate has no consumer here yet, and the over-return it was meant
   * to remove is still paid on every reconnect. The real consumer is the TUI
   * barrier, which knows the aggregates it must resume: that is
   * `packages/tui/src/context/sync.tsx`, still open under EOT-15.
   */
  async catchUp(): Promise<void> {
    await this.ingestQueue.catch(() => {})
    this.ingestQueue = Promise.resolve()
    let cursor: BacklogCursor | undefined
    for (;;) {
      const url = new URL(`${this.opts.url.replace(/\/$/, "")}/sync/outbox`)
      url.searchParams.set("projectID", this.opts.projectID)
      url.searchParams.set("since", String(cursor?.seq ?? 0))
      if (cursor) {
        url.searchParams.set("afterAggregate", cursor.aggregate)
        url.searchParams.set("afterID", cursor.id)
      }
      const res = await fetch(url.toString(), {
        headers: { authorization: `Bearer ${this.opts.token}` },
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) throw new Error(`catch-up HTTP ${res.status}`)
      const body = (await res.json()) as BacklogResponse
      for (const event of body.events) await this.ingest(event)
      if (!body.hasMore) return
      const next = body.nextCursor
      if (
        !next ||
        (cursor &&
          (next.seq < cursor.seq ||
            (next.seq === cursor.seq &&
              (next.aggregate < cursor.aggregate || (next.aggregate === cursor.aggregate && next.id <= cursor.id)))))
      ) {
        throw new Error("catch-up cursor did not advance")
      }
      cursor = next
    }
  }

  private subscribe(): void {
    if (this.stopped) return
    const url = new URL(`${this.opts.url.replace(/\/$/, "")}/sync/stream`)
    url.searchParams.set("projectID", this.opts.projectID)

    // EventSource sends credentials as query string only; the token must
    // be passed via a separate header which EventSource does not support.
    // Workaround: append the token as a query param on a TLS-only URL.
    // The server validates the token on every event message.
    url.searchParams.set("token", this.opts.token)

    try {
      this.source = new EventSource(url.toString())
      this.source.addEventListener("sync", (raw) => {
        try {
          const messageEvent = raw as MessageEvent
          const event = JSON.parse(messageEvent.data) as SyncEventRecord
          void this.ingest(event).catch((error) => {
            log.warn("sync event callback failed", { error })
            this.source?.close()
            this.source = undefined
            this.scheduleReconnect()
          })
        } catch (error) {
          log.warn("malformed sync event", { error })
        }
      })
      this.source.addEventListener("error", () => {
        if (this.stopped) return
        this.source?.close()
        this.source = undefined
        this.opts.onError?.(new Error("EventSource error"))
        this.scheduleReconnect()
      })
      this.backoffMs = 1000
    } catch (error) {
      log.warn("subscribe failed", { error })
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    if (this.reconnectTimer) return
    const delay = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, this.backoffCapMs)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.catchUp()
        .catch((error) => log.warn("catch-up failed", { error }))
        .finally(() => this.subscribe())
    }, delay)
  }
}
