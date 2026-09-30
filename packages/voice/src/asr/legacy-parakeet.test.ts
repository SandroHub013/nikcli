import { describe, expect, test } from "bun:test"
import { dropLegacyParakeet, LEGACY_PARAKEET_DB, type LegacyParakeetEnv } from "./legacy-parakeet"

/** A factory that answers the way IndexedDB does: the request's handlers are called after `deleteDatabase` returns. */
function factory(options: { has: boolean; outcome?: "success" | "error" | "blocked"; list?: boolean }) {
  const deleted: string[] = []
  const indexedDB = {
    deleteDatabase(name: string) {
      deleted.push(name)
      const request = {} as IDBOpenDBRequest
      queueMicrotask(() => {
        const outcome = options.outcome ?? "success"
        if (outcome === "success") request.onsuccess?.(new Event("success"))
        else if (outcome === "error") request.onerror?.(new Event("error"))
        else request.onblocked?.({} as IDBVersionChangeEvent)
      })
      return request
    },
    ...(options.list === false ? {} : { databases: async () => (options.has ? [{ name: LEGACY_PARAKEET_DB }, { name: "other" }] : [{ name: "other" }]) }),
  }
  return { indexedDB, deleted }
}

function memory() {
  const data = new Map<string, string>()
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data }
}

const env = (f: ReturnType<typeof factory>, storage = memory(), lines: string[] = []): LegacyParakeetEnv => ({
  indexedDB: f.indexedDB,
  storage,
  log: (line) => lines.push(line),
})

describe("the leftovers of the removed Parakeet engine", () => {
  test("the cached model is deleted, with a line in the log, and only once", async () => {
    const f = factory({ has: true })
    const storage = memory()
    const lines: string[] = []
    expect(await dropLegacyParakeet(env(f, storage, lines))).toEqual({ dropped: true, skipped: false })
    expect(f.deleted).toEqual([LEGACY_PARAKEET_DB])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("Parakeet")
    // The next start does nothing at all.
    expect(await dropLegacyParakeet(env(f, storage, lines))).toEqual({ dropped: false, skipped: true })
    expect(f.deleted).toHaveLength(1)
  })

  test("a user who never had the model gets no deletion and no log line", async () => {
    const f = factory({ has: false })
    const lines: string[] = []
    expect(await dropLegacyParakeet(env(f, memory(), lines))).toEqual({ dropped: false, skipped: false })
    expect(f.deleted).toEqual([])
    expect(lines).toEqual([])
  })

  test("where the browser cannot list its databases, the deletion is asked for anyway (deleting a database that is not there is fine)", async () => {
    const f = factory({ has: true, list: false })
    expect(await dropLegacyParakeet(env(f))).toEqual({ dropped: true, skipped: false })
    expect(f.deleted).toEqual([LEGACY_PARAKEET_DB])
  })

  test("a deletion that is blocked or fails is tried again next start: the flag is not set", async () => {
    for (const outcome of ["blocked", "error"] as const) {
      const f = factory({ has: true, outcome })
      const storage = memory()
      expect(await dropLegacyParakeet(env(f, storage))).toEqual({ dropped: false, skipped: false })
      expect(storage.data.size).toBe(0)
    }
  })

  test("without IndexedDB, or with one that throws, it does nothing and never throws", async () => {
    expect(await dropLegacyParakeet({ storage: memory() })).toEqual({ dropped: false, skipped: true })
    const broken: LegacyParakeetEnv = {
      indexedDB: { deleteDatabase: () => { throw new Error("no") } },
      storage: memory(),
    }
    expect(await dropLegacyParakeet(broken)).toEqual({ dropped: false, skipped: false })
  })
})
