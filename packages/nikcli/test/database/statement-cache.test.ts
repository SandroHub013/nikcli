import { removeTestDir } from "../helpers/fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterAll, describe, expect, it } from "bun:test"
import { inArray, sql } from "drizzle-orm"
import { Effect } from "effect"
import { project } from "@/database/schema"
import { Database } from "@/database/database"
import { runPromiseWithLayer } from "@/effect"

/**
 * Covers the bounded statement cache in front of the Drizzle connection.
 *
 * Drizzle 1.0 compiles through `Database.query`, whose cache never evicts, and
 * the query shapes are not bounded by the code: `inArray` emits one
 * placeholder per element, so the same call site is a new shape for every
 * list length it is ever given. The wrapper caps what that can retain.
 *
 * The risk the cap introduces is eviction: a compiled statement is finalized
 * when it falls out, so the shapes here deliberately run past the limit and
 * then come back to an evicted one.
 */

const testDir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-statement-cache-"))
const dbPath = path.join(testDir, "nikcli.db")

function runDatabase<A, E>(effect: Effect.Effect<A, E, Database.Service>) {
  return runPromiseWithLayer(Database.layerFromPath(dbPath), effect)
}

/** Matches `STATEMENT_CACHE_LIMIT`; the point is to run past it. */
const LIMIT = 256

afterAll(async () => {
  await removeTestDir(testDir)
})

describe("Database statement cache", () => {
  it("keeps results correct across eviction, and recompiles an evicted shape", async () => {
    const result = await runDatabase(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const db = database.db

        yield* Effect.sync(() =>
          db.insert(project).values({ id: "p1", data: "{}", createdAt: 1, updatedAt: 1 }).onConflictDoNothing().run(),
        )

        // One distinct SQL shape per list length, well past the limit.
        const widths = [1, 2, 3]
        const firstPass = widths.map((width) => queryWidth(db, width))

        for (let width = 1; width <= LIMIT + 5; width++) queryWidth(db, width)

        // Shapes 1..3 are the oldest, so they are gone by now.
        const afterEviction = widths.map((width) => queryWidth(db, width))

        const cached = database.native.query<{ count: number }, []>("SELECT count(*) AS count FROM project").get()

        return { firstPass, afterEviction, cached }
      }),
    )

    // A width-N query asks for N ids of which only "p1" exists.
    expect(result.firstPass).toEqual([1, 1, 1])
    expect(result.afterEviction).toEqual(result.firstPass)
    expect(result.cached?.count).toBe(1)
  })

  it("serves a repeated shape without recompiling it", async () => {
    const result = await runDatabase(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const db = database.db

        yield* Effect.sync(() =>
          db.insert(project).values({ id: "p2", data: "{}", createdAt: 1, updatedAt: 1 }).onConflictDoNothing().run(),
        )

        // `sqlite_stmt` is not available, so observe the cache the way a
        // caller can: the same shape many times must stay correct and must
        // not exhaust anything.
        const runs: number[] = []
        for (let i = 0; i < 200; i++) runs.push(queryWidth(db, 2))
        return runs
      }),
    )

    expect(new Set(result).size).toBe(1)
    expect(result[0]).toBe(1)
  })

  it("leaves the native handle unwrapped for raw SQL and pragmas", async () => {
    const result = await runDatabase(
      Effect.gen(function* () {
        const database = yield* Database.Service
        // The wrapper is applied to the Drizzle client only; `rawSql` and the
        // checkpoint loop must still reach the real connection.
        const raw = Database.rawSql("test/statement-cache").query<{ one: number }, []>("SELECT 1 AS one").get()
        const checkpoint = Database.checkpointWal(database.native)
        return { raw, checkpoint }
      }),
    )

    expect(result.raw?.one).toBe(1)
    expect(result.checkpoint).toBeDefined()
  })
})

/** A select whose SQL shape is a function of `width`, via `inArray`. */
function queryWidth(db: Database.Client, width: number): number {
  const ids = Array.from({ length: width }, (_, index) => (index === 0 ? "p1" : `absent-${index}`))
  return db
    .select({ count: sql<number>`count(*)` })
    .from(project)
    .where(inArray(project.id, ids))
    .get()!.count
}
