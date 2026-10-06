import { Database as BunDatabase, type Statement } from "bun:sqlite"
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import fs from "fs"
import nodePath from "path"
import { Context, Effect, Exit, Layer, Schema } from "effect"
import { Global } from "@nikcli-ai/util/global"
import { Log } from "@nikcli-ai/util/log"
import { errorMessage } from "@nikcli-ai/util/error-format"
import { DatabaseMigration } from "./migration"
import { assertNotARealFolder } from "./test-guard"

export namespace Database {
  const log = Log.create({ service: "database" })

  export type Client = SQLiteBunDatabase

  export interface Interface {
    readonly db: Client
    readonly native: BunDatabase
    readonly filename: string
    /**
     * Release the file: finalize every cached statement, then close.
     *
     * The order is the whole point, and it is not interchangeable. `close()`
     * alone leaves the connection a zombie when statements are still open —
     * SQLite defers the real teardown until the last one is finalized — and
     * Windows keeps the file handle until then, so a directory can only be
     * deleted at process exit. Finalizing first makes `close()` the last
     * reference to the file and the handle goes back immediately.
     */
    close(): void
  }

  export class Service extends Context.Service<Service, Interface>()("Database.Service") {}

  export function path() {
    const configured = process.env.NIKCLI_DB
    if (configured) {
      if (configured === ":memory:" || nodePath.isAbsolute(configured)) return configured
      return nodePath.join(Global.Path.data, configured)
    }
    return nodePath.join(Global.Path.data, "nikcli.db")
  }

  /**
   * How many compiled statements the Drizzle connection may hold.
   *
   * Sized above the number of distinct query shapes the domain modules emit,
   * so steady-state traffic never evicts; the bound only bites under a shape
   * storm. Raising it trades RSS for compile hits on a churning workload,
   * which is not the workload we have.
   */
  const STATEMENT_CACHE_LIMIT = 256

  /**
   * A bounded prepared-statement cache for the Drizzle connection.
   *
   * Drizzle compiles through `Database.query`, which caches statements on the
   * connection and never evicts them — 2000 distinct SQL shapes cost ~75MB of
   * RSS that `close()` does not reclaim. The shape count is not bounded by the
   * code that writes the queries: `inArray` and batch inserts emit one
   * placeholder per element, so a query over a variable-length list is a new
   * shape for every length it is ever called with.
   *
   * Routing `query` through an LRU over `prepare` keeps the compile savings —
   * a hit returns the same compiled statement `query` would have — while
   * capping what a shape storm can retain. Eviction finalizes, which is safe
   * because `bun:sqlite` is synchronous: a statement is executed in the same
   * tick it is handed out, so nothing can evict one that is still in flight.
   *
   * `prepare` is intercepted for the same reason `query` is: a migration that
   * prepares directly would otherwise leave the one statement that keeps the
   * connection a zombie after `close()`. Sharing the cache with `query` is
   * sound for the same reason the LRU is — every caller runs its statement
   * synchronously, before anything can evict it.
   *
   * The wrapped client is what `Interface` hands out as `native` as well as to
   * Drizzle, so `rawSql` and the checkpoint loop are covered by the same cache
   * and the same release. Only the real handle stays private, because
   * `close()` must reach the connection and not a proxy of it.
   *
   * The cache is reachable from here rather than left to the garbage collector
   * on purpose: a statement is a live reference into the connection, so a cache
   * that is only ever dropped implicitly holds the database open on Windows even
   * after `close()` reported success. See `Interface.close`.
   */
  interface BoundedStatements {
    readonly client: BunDatabase
    /** Finalize and forget every cached statement, so none outlives `close()`. */
    finalizeAll(): void
  }

  function boundedStatements(native: BunDatabase, limit = STATEMENT_CACHE_LIMIT): BoundedStatements {
    const cache = new Map<string, Statement>()

    function query(sql: string): Statement {
      const hit = cache.get(sql)
      if (hit) {
        // Re-insert to mark as most recently used.
        cache.delete(sql)
        cache.set(sql, hit)
        return hit
      }

      const compiled = native.prepare(sql)
      cache.set(sql, compiled)
      if (cache.size > limit) {
        const oldest = cache.keys().next().value as string
        const evicted = cache.get(oldest)
        cache.delete(oldest)
        evicted?.finalize()
      }
      return compiled
    }

    const client = new Proxy(native, {
      get(target, property) {
        if (property === "query" || property === "prepare") return query
        // `bun:sqlite`'s methods are native and reject a proxy as their
        // receiver, so they are handed back bound to the real connection.
        const value = target[property as keyof BunDatabase]
        return value instanceof Function ? value.bind(target) : value
      },
    })

    function finalizeAll() {
      for (const statement of cache.values()) {
        try {
          statement.finalize()
        } catch {}
      }
      cache.clear()
    }

    return { client, finalizeAll }
  }

  function open(filename: string): Interface {
    assertNotARealFolder(filename)
    if (filename !== ":memory:") fs.mkdirSync(nodePath.dirname(filename), { recursive: true })

    log.info("opening database", { filename })
    const native = new BunDatabase(filename, { create: true })
    // Built before the pragmas and the migrations run, and used for both, so
    // that every statement this connection compiles is one the cache knows
    // about. The migration runner issues its own `query` calls: routed around
    // the cache they would be the statements that survive `close()` and keep
    // the file locked on Windows, and the leak would be invisible until the
    // directory could not be deleted.
    const bounded = boundedStatements(native)
    const client = bounded.client
    client.exec("PRAGMA journal_mode = WAL")
    client.exec("PRAGMA synchronous = NORMAL")
    client.exec("PRAGMA busy_timeout = 5000")
    client.exec("PRAGMA cache_size = -64000")
    client.exec("PRAGMA foreign_keys = ON")
    // Opencode #22428: disable mmap so the process footprint doesn't grow
    // with the DB file size. Default cache_size (~64MB) bounds the cache
    // anyway, and the latency cost is dwarfed by LLM API round-trips.
    client.exec("PRAGMA mmap_size = 0")
    DatabaseMigration.apply(client)
    client.exec("PRAGMA wal_checkpoint(PASSIVE)")

    return {
      db: drizzle({ client }),
      // The wrapped client, not the bare handle: a `query` a caller issues here
      // is compiled through the same cache, so `close()` can finalize it. The
      // real handle stays private to this closure — it is the only thing that
      // must reach the connection itself to close it.
      native: client,
      filename,
      close() {
        // Statements first: they are the last references into the connection,
        // and until they are finalized `close()` only marks it a zombie.
        bounded.finalizeAll()
        try {
          native.close()
        } catch {}
      },
    }
  }

  // ============================================================================
  // Synchronous singleton for domain modules
  // ============================================================================

  const singletons = new Map<string, Interface>()

  function singleton(): Interface {
    const filename = path()
    const existing = singletons.get(filename)
    if (existing) return existing
    const service = open(filename)
    singletons.set(filename, service)
    // Start the periodic WAL checkpoint loop on first DB open. No-op
    // thereafter if the same filename is reused.
    startWalCheckpointLoop()
    return service
  }

  /** Shared Drizzle client for all domain modules. Safe to call from synchronous code. */
  export function syncDb(): Client {
    return singleton().db
  }

  /**
   * Shared native SQLite client.
   *
   * Tests, migrations, and admin tooling only — production code must not call
   * this. `test/database/wrapper-inventory.test.ts` asserts it stays absent
   * from `src`. Production SQL the query builder cannot express goes through
   * `rawSql`, which is narrower and says who is asking.
   */
  export function syncNative(): BunDatabase {
    return singleton().native
  }

  /**
   * The native handle narrowed to `query`, for SQL Drizzle's builder cannot
   * express.
   *
   * Analytics is the reason this exists: its aggregates are `json_extract`
   * sums over `message_part.info` grouped by `date(created_at/1000,
   * 'unixepoch')`, which is not a query builder shape, and rewriting them
   * would trade readable SQL for a slower plan on a table that reaches ~600MB.
   *
   * Narrowed rather than handed over whole: a caller gets `query` and not
   * `exec`, `close`, `transaction`, or `serialize`. `purpose` is logged once
   * per distinct value, so who bypasses the builder is visible at runtime
   * rather than only in a grep. `specs/storage/retire-database-wrapper.md`
   * group 2.
   */
  export type RawSql = Pick<BunDatabase, "query">

  const rawPurposes = new Set<string>()

  export function rawSql(purpose: string): RawSql {
    if (!rawPurposes.has(purpose)) {
      rawPurposes.add(purpose)
      log.debug("raw sql consumer", { purpose })
    }
    return singleton().native
  }

  /** Close a synchronous database handle before its backing directory is removed. */
  export function close(filename = path()): boolean {
    const service = singletons.get(filename)
    if (!service) return false
    // Drop the map entry first: the retained `Interface` is the only other
    // reference to the handle, and leaving it reachable is what keeps a closed
    // database collectable-later instead of collectable-now.
    singletons.delete(filename)
    try {
      service.close()
    } catch {}
    return true
  }

  /** Close every synchronous database handle owned by this process. */
  export function closeAll(): void {
    stopWalCheckpointLoop()
    for (const filename of Array.from(singletons.keys())) close(filename)
  }

  /** Test and diagnostics hook for asserting lifecycle cleanup. */
  export function isOpen(filename = path()): boolean {
    return singletons.has(filename)
  }

  // ============================================================================
  // Transactions and post-commit effects
  // ============================================================================

  /** A Drizzle executor: either the root client or a transaction handle. */
  export type Tx = Parameters<Parameters<Client["transaction"]>[0]>[0]
  export type TxOrDb = Client | Tx

  export type TransactionBehavior = "deferred" | "immediate" | "exclusive"

  /**
   * What a transaction body can do besides write.
   *
   * `afterCommit` queues a side effect to run once the outermost transaction
   * has committed — never on rollback, and never while the write lock is
   * still held. Publishing from inside the transaction would let a subscriber
   * observe a state a rollback could still undo.
   *
   * This used to be a module-level queue reached through an ambient
   * `Database.effect(...)`. Handing the registrar to the body instead means a
   * function that defers work says so in its signature, and a caller cannot
   * queue against a transaction it is not in. `specs/storage/retire-database-wrapper.md`
   * group 1.
   */
  export interface TransactionContext {
    afterCommit(fn: () => void): void
  }

  /** The queue shared by an outermost transaction and every nested call inside it. */
  type PostCommitQueue = (() => void)[]

  // ============================================================================
  // Effect access
  // ============================================================================

  /**
   * A query that did not complete.
   *
   * `operation` names the call site rather than the SQL, because the SQL is
   * generated and a reader chasing a failure wants to know which repository
   * asked, not which placeholders it used.
   */
  export class QueryError extends Schema.TaggedError<QueryError>()("DatabaseQueryError", {
    operation: Schema.String,
    message: Schema.String,
  }) {}

  /**
   * Run a Drizzle query as an Effect, so a repository's failure mode is visible
   * in its type instead of being thrown past its callers.
   *
   * `run` is handed an executor and must stay synchronous — every `bun:sqlite`
   * query already is, and this is the property that keeps the wrapper free:
   * measured at 8.29µs against 7.75µs for the same call made directly, where
   * moving to Drizzle's Effect driver instead costs 17.03µs.
   *
   * The executor defaults to the shared connection. Passing one explicitly is
   * how a repository joins a transaction it was handed.
   */
  export function query<A>(operation: string, run: (db: TxOrDb) => A, executor?: TxOrDb): Effect.Effect<A, QueryError> {
    return Effect.try({
      try: () => run(executor ?? (syncDb() as TxOrDb)),
      catch: (error) => new QueryError({ operation, message: describe(error) }),
    })
  }

  /**
   * The message a reader needs, not the one the query builder throws.
   *
   * Drizzle wraps a failure in `DrizzleQueryError`, whose message is the SQL
   * and its parameters — which says what was asked, never what went wrong. The
   * SQLite error that actually explains it ("no such table", "database is
   * locked", "UNIQUE constraint failed") is on `cause`, so it is folded in.
   */
  function describe(error: unknown): string {
    const message = errorMessage(error)
    const cause = error instanceof Error ? error.cause : undefined
    if (!cause) return message
    const reason = errorMessage(cause)
    return reason && !message.includes(reason) ? `${reason} — ${message}` : message
  }

  /**
   * Thrown to make `bun:sqlite` roll back, carrying the body's Exit back out
   * so its own failure — not this marker — is what the caller sees.
   */
  class Rollback {
    constructor(readonly exit: Exit.Exit<unknown, unknown>) {}
  }

  /**
   * Run `fn` in a transaction, draining post-commit effects afterwards.
   *
   * Nested calls join the outer transaction (SQLite has no real nesting that
   * would help here) and share its queue, so an effect queued in a nested
   * block drains with the outermost commit and a rolled-back inner write can
   * never publish.
   *
   * `behavior` defaults to "immediate": a read-then-write sequence (allocate
   * a sequence number, then append) must take the write lock up front or two
   * processes sharing nikcli.db can both read the same number.
   *
   * The body is an Effect, evaluated to completion before the driver commits.
   * A failure rolls the transaction back and surfaces as the body's own error;
   * a body that suspends on something asynchronous fails rather than
   * committing at its first suspension, which is the rule `bun:sqlite` already
   * imposes on an `async` callback.
   */
  export function transaction<A, E, R>(
    fn: (tx: TxOrDb, ctx: TransactionContext) => Effect.Effect<A, E, R>,
    options: { behavior?: TransactionBehavior } = {},
  ): Effect.Effect<A, E | QueryError, R> {
    return Effect.suspend(() => {
      // Set while an outermost transaction is open, so a nested `transaction`
      // can find the queue to join. Nothing outside this function reads it.
      if (activeQueue) return fn(syncDb() as TxOrDb, contextFor(activeQueue))

      const queue: PostCommitQueue = []
      activeQueue = queue

      let exit: Exit.Exit<A, E> | undefined
      try {
        syncDb().transaction(
          (tx) => {
            // The body is evaluated here rather than returned, because the
            // driver commits when this callback returns. A body that suspends
            // on something asynchronous fails the Exit instead of committing
            // early — the same rule the driver enforces for `async` callbacks.
            exit = Effect.runSyncExit(fn(tx as TxOrDb, contextFor(queue)) as Effect.Effect<A, E>)
            if (Exit.isFailure(exit)) throw new Rollback(exit)
            return undefined as never
          },
          { behavior: options.behavior ?? "immediate" },
        )
      } catch (error) {
        activeQueue = undefined
        if (!(error instanceof Rollback)) {
          return Effect.fail(new QueryError({ operation: "transaction", message: errorMessage(error) }))
        }
        return exit as Effect.Effect<A, E, R>
      }

      activeQueue = undefined
      for (const effect of queue) {
        try {
          effect()
        } catch (error) {
          log.warn("post-commit effect failed", { error: errorMessage(error) })
        }
      }
      return (exit ??
        Effect.fail(
          new QueryError({ operation: "transaction", message: "transaction produced no result" }),
        )) as Effect.Effect<A, E | QueryError, R>
    })
  }

  let activeQueue: PostCommitQueue | undefined

  function contextFor(queue: PostCommitQueue): TransactionContext {
    return {
      afterCommit(fn) {
        queue.push(fn)
      },
    }
  }

  // ============================================================================
  // Effect service layer
  // ============================================================================

  export function layerFromPath(filename: string) {
    return Layer.effect(
      Service,
      Effect.gen(function* () {
        const service = yield* Effect.sync(() => open(filename))
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            // The Effect runtime keeps the `Interface` reachable past this
            // finalizer, so the release cannot rely on the handle becoming
            // unreachable. It has to happen explicitly: finalize every cached
            // statement, then close. The singleton entry, if this path is also
            // registered as one, is dropped too, so nothing module-level is
            // left holding a closed handle.
            if (singletons.get(filename) === service) singletons.delete(filename)
            service.close()
          }),
        )
        return Service.of(service)
      }),
    )
  }

  export const defaultLayer = Layer.unwrap(Effect.sync(() => layerFromPath(path())))

  // ============================================================================
  // Periodic WAL checkpoint
  // ============================================================================
  // PR counterpart to opencode #22428 (mmap_size=0): PRAGMA wal_checkpoint(TRUNCATE)
  // every 5 minutes prevents the WAL file from growing unbounded. PASSIVE
  // is used on writes (already done at open); TRUNCATE reclaims the WAL file
  // back to size 0. Lock contention is rare because checkpoint is fast on
  // an idle DB.

  const WAL_CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000
  let checkpointTimer: ReturnType<typeof setInterval> | undefined

  export function checkpointWal(native: BunDatabase) {
    return native
      .query<{ busy: number; log: number; checkpointed: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)")
      .get()
  }

  /**
   * Start a background timer that periodically runs `wal_checkpoint(TRUNCATE)`.
   * Safe to call multiple times (no-ops after the first). Stops on SIGINT/SIGTERM
   * and on process exit so it never holds the DB open after shutdown.
   */
  export function startWalCheckpointLoop(): void {
    if (checkpointTimer) return
    if (process.env["NIKCLI_DISABLE_WAL_CHECKPOINT"] === "1") return
    checkpointTimer = setInterval(() => {
      try {
        const native = syncNative()
        const row = checkpointWal(native)
        if (row && row.checkpointed > 0) {
          log.debug("wal checkpoint", row)
        }
      } catch (error) {
        log.warn("wal checkpoint failed", { error: errorMessage(error) })
      }
    }, WAL_CHECKPOINT_INTERVAL_MS)
    checkpointTimer.unref?.()
    process.once("SIGINT", stopWalCheckpointLoop)
    process.once("SIGTERM", stopWalCheckpointLoop)
    process.once("beforeExit", stopWalCheckpointLoop)
  }

  export function stopWalCheckpointLoop(): void {
    if (!checkpointTimer) return
    clearInterval(checkpointTimer)
    checkpointTimer = undefined
  }
}
