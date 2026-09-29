/**
 * RemoteSync — high-level entry point for the optional Railway-style
 * hub-and-spoke sync.
 *
 * Usage:
 *   const stop = await RemoteSync.start({
 *     url: "https://s.nikcli-ai.dev",
 *     token: process.env.NIKCLI_REMOTE_TOKEN!,
 *     projectID: Instance.project.id,
 *   })
 *   // ... later
 *   await stop()
 *
 * The started sync does three things concurrently:
 *  1. Subscribe to remote events via the injected `RemoteTransport`.
 *  2. Periodically drain the local outbox via the injected `Scheduler`.
 *  3. Subscribe to `Sync.onEmit` so local events are enqueued for push.
 *
 * The transport and scheduler are Adapters — the production wiring uses
 * `createHttpRemoteTransport` + `realScheduler`, while tests inject
 * `createInMemoryRemoteTransport` + `createInMemoryScheduler`.
 */
import type { JsonValue } from "@/util/json"
import { Effect } from "effect"
import { Log } from "@nikcli-ai/util/log"
import { Database } from "@/database/database"
import { and, eq } from "drizzle-orm"
import { syncEvent } from "./sync.sql"
import { Outbox } from "./outbox"
import { Sync, type SyncEventRecord } from "./index"
import { InstructionRepo } from "@/session/instruction-repo"
import {
  createHttpRemoteTransport,
  realScheduler,
  type RemoteTokenResolver,
  type RemoteTransport,
  type Scheduler,
} from "./transport"

const log = Log.create({ service: "sync.remote" })

export type RemoteSyncOptions = {
  url: string
  token: string
  resolveToken?: RemoteTokenResolver
  projectID: string
  drainIntervalMs?: number
  clientId?: string
  /** Override the transport for testing. Defaults to the HTTP+EventSource
   *  client built by `createHttpRemoteTransport`. */
  transport?: RemoteTransport
  /** Override the scheduler/clock for testing. Defaults to `realScheduler`. */
  scheduler?: Scheduler
}

export type RemoteSyncHandle = {
  stop(): Promise<void>
  status(): {
    connected: boolean
    lastSeq: number
    outbox: { pending: number; failed: number; total: number }
  }
}

export namespace RemoteSync {
  const active = new Map<string, { handle: RemoteSyncHandle; url: string }>()
  const enqueueTargets = new Set<string>()
  const hubErrors = new Map<string, string>()
  let removeEmitHook: (() => void) | undefined

  function normalizeUrl(url: string) {
    return url.replace(/\/$/, "")
  }

  function noteHubError(url: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    hubErrors.set(normalizeUrl(url), message)
  }

  function clearHubError(url: string) {
    hubErrors.delete(normalizeUrl(url))
  }

  function ensureEmitHook() {
    if (removeEmitHook) return
    const unsubscribe = Sync.onEmit((record, meta) => {
      if (meta.origin !== "local") return
      for (const target of enqueueTargets) {
        try {
          Effect.runSync(Outbox.enqueue(record.id, target))
        } catch (error) {
          log.warn("outbox enqueue failed", { target, error })
        }
      }
    })
    removeEmitHook = () => {
      unsubscribe()
      removeEmitHook = undefined
    }
  }

  function isInstructionEvent(type: string) {
    return type === "session.instructions.updated" || type.startsWith("session.instructions.updated.")
  }

  function loadEvent(eventId: string): SyncEventRecord | undefined {
    const row = Effect.runSync(
      Database.query("RemoteSync.loadEvent", (db) =>
        db.select().from(syncEvent).where(eq(syncEvent.id, eventId)).get(),
      ),
    )
    if (!row) return undefined
    const record: SyncEventRecord = {
      id: row.id,
      projectId: row.projectId,
      workspaceId: row.workspaceId ?? undefined,
      aggregate: row.aggregate,
      seq: row.seq,
      type: row.type,
      data: safeJson(row.data),
      timestamp: row.timestamp,
      origin: row.origin,
      originSeq: row.originSeq ?? undefined,
    }
    if (!isInstructionEvent(record.type)) return record
    const delta = (record.data as { delta?: Record<string, string> } | null)?.delta
    if (!delta) return record
    const hashes = Object.values(delta).filter((value) => value !== "removed")
    return {
      ...record,
      blobs: Effect.runSync(InstructionRepo.getBlobs(hashes)),
    }
  }

  async function ingestIncoming(event: SyncEventRecord): Promise<SyncEventRecord> {
    if (!event.blobs || Object.keys(event.blobs).length === 0) {
      const next = { ...event }
      delete next.blobs
      return next
    }
    const { InstructionSync } = await import("@/session/instruction-sync")
    return InstructionSync.takeBlobs(event)
  }

  function safeJson(value: string): JsonValue {
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }

  const starting = new Map<string, Promise<RemoteSyncHandle>>()

  /** Whether a live remote-sync session is running for the given hub/project. */
  export function isActive(input?: { url?: string; projectID?: string }): boolean {
    if (input?.url && input.projectID) {
      return active.has(`${normalizeUrl(input.url)}::${input.projectID}`)
    }
    if (input?.url) {
      const normalized = normalizeUrl(input.url)
      return [...active.values()].some((entry) => entry.url === normalized)
    }
    if (input?.projectID) {
      return [...active.keys()].some((key) => key.endsWith(`::${input.projectID}`))
    }
    return active.size > 0
  }

  /** Last hub transport error for the URL, if any (e.g. HTTP 403). */
  export function lastHubError(url: string): string | undefined {
    return hubErrors.get(normalizeUrl(url))
  }

  export function start(opts: RemoteSyncOptions): Promise<RemoteSyncHandle> {
    const normalizedUrl = normalizeUrl(opts.url)
    const key = `${normalizedUrl}::${opts.projectID}`
    const existing = active.get(key)
    if (existing) return Promise.resolve(existing.handle)
    let inflight = starting.get(key)
    if (!inflight) {
      inflight = doStart(opts, key)
      starting.set(key, inflight)
      const settle = () => {
        if (starting.get(key) === inflight) starting.delete(key)
      }
      inflight.then(settle, settle)
    }
    return inflight
  }

  async function doStart(opts: RemoteSyncOptions, key: string): Promise<RemoteSyncHandle> {
    const hubUrl = normalizeUrl(opts.url)
    const originTag = `remote:${opts.clientId ?? "cli"}:${hubUrl}`
    const drainInterval = opts.drainIntervalMs ?? 5_000
    let connected = false
    let lastSeq = 0

    const transport: RemoteTransport =
      opts.transport ??
      createHttpRemoteTransport({
        url: opts.url,
        token: opts.token,
        resolveToken: opts.resolveToken,
        projectID: opts.projectID,
        onError: (error) => {
          connected = false
          log.warn("remote sync connection error", { error })
        },
      })

    const scheduler: Scheduler = opts.scheduler ?? realScheduler

    let stopped = false
    let fenced = false
    let generation = 0
    let work: Promise<void> = Promise.resolve()
    let recovery: Promise<void> | undefined
    let requested = false
    let scheduled = false
    const cursors = new Map<string, number>()
    const applied = Effect.runSync(
      Database.query("RemoteSync.applied", (db) =>
        db
          .select({ aggregate: syncEvent.aggregate, seq: syncEvent.originSeq })
          .from(syncEvent)
          .where(and(eq(syncEvent.projectId, opts.projectID), eq(syncEvent.origin, originTag)))
          .all(),
      ),
    )
    for (const row of applied) {
      if (row.seq === null) continue
      cursors.set(row.aggregate, Math.max(cursors.get(row.aggregate) ?? 0, row.seq))
      lastSeq = Math.max(lastSeq, row.seq)
    }

    async function apply(event: SyncEventRecord) {
      if (stopped) return
      if (
        event.projectId !== opts.projectID ||
        !event.aggregate ||
        !event.id ||
        !Number.isSafeInteger(event.seq) ||
        event.seq < 1
      )
        throw new Error("invalid remote sync event")
      if (event.seq <= (cursors.get(event.aggregate) ?? 0)) return
      const incoming = await ingestIncoming(event)
      if (stopped) return
      await Sync.emitRaw(incoming.projectId, incoming.aggregate, incoming.data, {
        workspaceID: incoming.workspaceId,
        origin: originTag,
        originSeq: incoming.seq,
      })
      if (stopped) return
      cursors.set(event.aggregate, event.seq)
      lastSeq = Math.max(lastSeq, event.seq)
    }

    function recover(): Promise<void> {
      requested = true
      if (recovery) return recovery
      recovery = (async () => {
        while (requested && !stopped && fenced) {
          requested = false
          connected = false
          const epoch = generation
          // Always enumerate from zero: a previously unknown aggregate may have
          // history below every known watermark. The keyset is only a page position.
          let cursor: import("./transport").BacklogCursor | undefined
          let pages = 0
          for (;;) {
            if (++pages > 10_000) throw new Error("remote recovery page budget exceeded")
            const page = await transport.pullBacklog(0, cursor)
            if (stopped || epoch !== generation) return
            for (const event of page.events) {
              if (stopped || epoch !== generation) return
              await apply(event)
            }
            if (!page.hasMore) break
            const next = page.nextCursor
            if (
              !next ||
              (cursor &&
                (next.seq < cursor.seq ||
                  (next.seq === cursor.seq &&
                    (next.aggregate < cursor.aggregate ||
                      (next.aggregate === cursor.aggregate && next.id <= cursor.id)))))
            ) {
              throw new Error("backlog pagination did not advance; composite cursor support required")
            }
            cursor = next
          }
          if (!stopped && epoch === generation && fenced) {
            connected = true
            clearHubError(hubUrl)
          }
        }
      })()
        .catch((error) => {
          if (stopped) return
          connected = false
          noteHubError(hubUrl, error)
          log.warn("remote recovery failed", { error })
        })
        .finally(() => {
          recovery = undefined
        })
      return recovery
    }

    function scheduleRecovery() {
      if (stopped || !fenced) return
      requested = true
      if (scheduled) return
      scheduled = true
      work = work
        .then(() => recover())
        .finally(() => {
          scheduled = false
          if (requested && fenced && !stopped) scheduleRecovery()
        })
    }

    const unsubscribe = transport.subscribe(
      () => {
        // Notifications are wakeups, not acknowledgements. Read the journal in
        // aggregate sequence order instead of applying an out-of-order live tail.
        scheduleRecovery()
      },
      {
        ready() {
          if (stopped) return
          fenced = true
          generation++
          scheduleRecovery()
        },
        stale(error) {
          if (stopped) return
          fenced = false
          generation++
          connected = false
          noteHubError(hubUrl, error)
        },
        wake: scheduleRecovery,
      },
    )

    log.info("remote sync started", {
      url: opts.url,
      projectID: opts.projectID,
    })

    const drainHandle = scheduler.interval(() => {
      if (stopped) return
      if (!connected) scheduleRecovery()
      void Outbox.drain(hubUrl, async (eventId) => {
        if (stopped) return { ok: false, error: "sync stopped" }
        const event = loadEvent(eventId)
        if (!event) return { ok: false, permanent: true, error: "event not found" }
        const outcome = await transport.push(event)
        if (outcome.ok) {
          clearHubError(hubUrl)
          return { ok: true }
        }
        if (outcome.error) noteHubError(hubUrl, outcome.error)
        return {
          ok: false,
          permanent: outcome.permanent === true,
          error: outcome.error,
        }
      }).catch((error) => {
        log.warn("outbox drain failed", { error })
      })
    }, drainInterval)

    enqueueTargets.add(hubUrl)
    ensureEmitHook()

    const handle: RemoteSyncHandle = {
      stop: async () => {
        if (stopped) return
        stopped = true
        generation++
        connected = false
        drainHandle.clear()
        unsubscribe()
        transport.close()
        active.delete(key)
        const urlStillUsed = [...active.values()].some((entry) => entry.url === hubUrl)
        if (!urlStillUsed) {
          enqueueTargets.delete(hubUrl)
          hubErrors.delete(hubUrl)
        }
        if (active.size === 0) removeEmitHook?.()
        connected = false
        log.info("remote sync stopped")
      },
      status: () => ({
        connected,
        lastSeq,
        outbox: Effect.runSync(Outbox.status(opts.url)),
      }),
    }

    active.set(key, { handle, url: hubUrl })
    return handle
  }
}
