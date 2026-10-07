import { describe, expect, test } from "bun:test"
import { parseMessage } from "./mailbox"
import {
  KV_MAX_VALUE,
  MEMORY_HEADER,
  MEMORY_SOFT_LIMIT,
  KV_MACHINE_SPACE,
  applyKv,
  applyKvAcross,
  cacheHitPercent,
  emptySpace,
  kvSpaceFor,
  memoryAddReply,
  memoryEntry,
  parseKvStore,
  statsTable,
  withMemoryEntry,
  type KvRequest,
  type KvSpace,
} from "./shared"
import { planFork } from "../session-new/resume"

const alice = { id: "p1", title: "alice" }
const bob = { id: "p2", title: "bob" }
const req = (op: KvRequest["op"], key: string, value = "", extra: Partial<KvRequest> = {}): KvRequest => ({
  op,
  key,
  value,
  ttl: 0,
  force: false,
  ...extra,
})
const everyoneAlive = () => true

describe("kv store", () => {
  test("set, get, list, del", () => {
    let space = emptySpace()
    space = applyKv(space, req("set", "build/status", "verde"), alice, 1000, everyoneAlive).space
    expect(applyKv(space, req("get", "build/status"), bob, 2000, everyoneAlive).reply).toBe("ok\nverde")
    expect(applyKv(space, req("list", "build/"), bob, 2000, everyoneAlive).reply).toContain(
      "build/status = verde  (alice",
    )
    const deleted = applyKv(space, req("del", "build/status"), bob, 3000, everyoneAlive)
    expect(deleted.reply).toBe("ok: build/status cancellata")
    expect(applyKv(deleted.space, req("get", "build/status"), bob, 3000, everyoneAlive).reply).toStartWith("errore")
  })

  test("reads are free, writes need a proven session", () => {
    const space = applyKv(emptySpace(), req("set", "k", "v"), alice, 0, everyoneAlive).space
    expect(applyKv(space, req("get", "k"), undefined, 0, everyoneAlive).reply).toBe("ok\nv")
    for (const op of ["set", "del", "lock", "unlock"] as const) {
      expect(applyKv(space, req(op, "k", "x"), undefined, 0, everyoneAlive).reply).toStartWith("errore")
    }
  })

  test("a lock keeps others out until it is released, expires, or its owner is gone", () => {
    let space = applyKv(emptySpace(), req("lock", "src/auth", "refactor", { ttl: 60 }), alice, 0, everyoneAlive).space
    expect(applyKv(space, req("lock", "src/auth"), bob, 1000, everyoneAlive).reply).toContain('bloccata da "alice"')
    expect(applyKv(space, req("set", "src/auth", "x"), bob, 1000, everyoneAlive).reply).toStartWith("errore")
    expect(applyKv(space, req("unlock", "src/auth"), bob, 1000, everyoneAlive).reply).toStartWith("errore")
    expect(applyKv(space, req("unlock", "src/auth", "", { force: true }), bob, 1000, everyoneAlive).reply).toBe(
      "ok: src/auth rilasciata",
    )
    // Expired.
    expect(applyKv(space, req("lock", "src/auth"), bob, 61_000, everyoneAlive).reply).toStartWith("ok")
    // Owner gone.
    expect(applyKv(space, req("lock", "src/auth"), bob, 1000, (id) => id !== "p1").reply).toStartWith("ok")
    space = applyKv(space, req("unlock", "src/auth"), alice, 2000, everyoneAlive).space
    expect(space.locks["src/auth"]).toBeUndefined()
  })

  test("limits and keys", () => {
    expect(applyKv(emptySpace(), req("set", "bad key", "v"), alice, 0, everyoneAlive).reply).toStartWith("errore")
    expect(
      applyKv(emptySpace(), req("set", "k", "x".repeat(KV_MAX_VALUE + 1)), alice, 0, everyoneAlive).reply,
    ).toStartWith("errore")
    expect(applyKv(emptySpace(), req("list", ""), alice, 0, everyoneAlive).reply).toBe("ok\n(vuoto)")
  })

  test("a saved store survives a round trip and drops what is malformed", () => {
    const space = applyKv(emptySpace(), req("set", "k", "v"), alice, 5, everyoneAlive).space
    const raw = JSON.stringify({
      proj: space,
      junk: 3,
      other: { entries: { "bad key": { value: "v", by: "x", at: 1 } } },
    })
    const parsed = parseKvStore(raw)
    expect(parsed.proj).toEqual(space)
    expect(parsed.other).toEqual(emptySpace())
    expect(parseKvStore("nope")).toEqual({})
  })
})

// Locks on what the machine has once (ADE Test, the bench, a GPU) are one for every project: their key starts with `pc:`.
describe("kv locks of the machine (pc:)", () => {
  type Store = Record<string, KvSpace>
  const call = (
    store: Store,
    project: string,
    who: { id: string; title: string },
    request: KvRequest,
    now = 1000,
  ) => applyKvAcross(store, { sender: project, ui: "nikcli" }, request, who, now, everyoneAlive)

  test("kvSpaceFor: a pc: key is one space for every project, the others are the sender's project", () => {
    expect(kvSpaceFor("pc:sweep", "nikcli", "ui")).toBe(KV_MACHINE_SPACE)
    expect(kvSpaceFor("pc:sweep", "sandrobench", "ui")).toBe(KV_MACHINE_SPACE)
    expect(kvSpaceFor("sweep", "nikcli", "ui")).toBe("nikcli")
    expect(kvSpaceFor("sweep", "sandrobench", "ui")).toBe("sandrobench")
    expect(kvSpaceFor("sweep", undefined, "ui")).toBe("ui")
    expect(kvSpaceFor("sweep", undefined, undefined)).toBe("workspace")
    // Not a prefix of the middle of a key.
    expect(kvSpaceFor("src/pc:x", "nikcli", "ui")).toBe("nikcli")
  })

  test("two projects on pc:sweep: the second gets the error", () => {
    let store: Store = {}
    const first = call(store, "nikcli", alice, req("lock", "pc:sweep"))
    expect(first.reply).toStartWith("ok")
    store = first.store
    const second = call(store, "sandrobench", bob, req("lock", "pc:sweep"))
    expect(second.reply).toStartWith("errore")
    expect(second.reply).toContain('"alice"')
  })

  test("two projects on sweep without the prefix: both get ok, as before", () => {
    let store: Store = {}
    store = call(store, "nikcli", alice, req("lock", "sweep")).store
    expect(call(store, "sandrobench", bob, req("lock", "sweep")).reply).toStartWith("ok")
  })

  test("the reply says where the lock holds", () => {
    expect(call({}, "nikcli", alice, req("lock", "pc:sweep")).reply).toContain("su tutta la macchina")
    const own = call({}, "nikcli", alice, req("lock", "sweep")).reply
    expect(own).toContain("nel progetto nikcli")
    expect(own).not.toContain("su tutta la macchina")
  })

  test("list from another project shows the pc: lock, and the project's own keys too", () => {
    let store: Store = {}
    store = call(store, "nikcli", alice, req("lock", "pc:ade-test", "Brief 34")).store
    store = call(store, "sandrobench", bob, req("set", "build/status", "verde")).store
    const seen = call(store, "sandrobench", bob, req("list", "")).reply
    expect(seen).toContain("lock pc:ade-test: alice")
    expect(seen).toContain("build/status = verde")
    // The project's keys of another project are not shown.
    expect(call(store, "nikcli", alice, req("list", "")).reply).not.toContain("build/status")
    // A prefix narrows both.
    expect(call(store, "sandrobench", bob, req("list", "pc:")).reply).toContain("lock pc:ade-test")
    expect(call(store, "sandrobench", bob, req("list", "build/")).reply).not.toContain("pc:ade-test")
  })

  test("list: an old pc: lock left in a project's space does not hide the machine's", () => {
    // Taken before pc: keys moved to the machine's space, with the key already pc:ade-test.
    const old: KvSpace = {
      entries: {},
      locks: { "pc:ade-test": { owner: "p9", ownerTitle: "vecchio", until: 1000 + 10_000 } },
    }
    let store: Store = { nikcli: old }
    store = call(store, "sandrobench", alice, req("lock", "pc:ade-test"), 1000).store
    const seen = call(store, "nikcli", bob, req("list", ""), 2000).reply
    expect(seen).toContain("lock pc:ade-test: alice")
    expect(seen).not.toContain("vecchio")
  })

  test("values under pc: are one for the machine too", () => {
    let store: Store = {}
    store = call(store, "nikcli", alice, req("set", "pc:gpu", "libera")).store
    expect(call(store, "sandrobench", bob, req("get", "pc:gpu")).reply).toBe("ok\nlibera")
  })

  test("the owner renews its own pc: lock and the expiry moves", () => {
    let store: Store = {}
    store = call(store, "nikcli", alice, req("lock", "pc:sweep", "", { ttl: 60 }), 1000).store
    const until = store[KV_MACHINE_SPACE]!.locks["pc:sweep"]!.until
    const renewed = call(store, "nikcli", alice, req("lock", "pc:sweep", "", { ttl: 600 }), 30_000)
    expect(renewed.reply).toStartWith("ok")
    expect(renewed.store[KV_MACHINE_SPACE]!.locks["pc:sweep"]!.until).toBeGreaterThan(until)
  })

  test("the expiry frees it for another project", () => {
    let store: Store = {}
    store = call(store, "nikcli", alice, req("lock", "pc:sweep", "", { ttl: 60 }), 1000).store
    expect(call(store, "sandrobench", bob, req("lock", "pc:sweep"), 30_000).reply).toStartWith("errore")
    expect(call(store, "sandrobench", bob, req("lock", "pc:sweep"), 61_001).reply).toStartWith("ok")
  })

  test("unlock from another project releases only the owner's lock, with --force the other's", () => {
    let store: Store = {}
    store = call(store, "nikcli", alice, req("lock", "pc:sweep")).store
    expect(call(store, "sandrobench", bob, req("unlock", "pc:sweep")).reply).toStartWith("errore")
    expect(call(store, "sandrobench", bob, req("unlock", "pc:sweep", "", { force: true })).reply).toStartWith("ok")
    expect(call(store, "nikcli", alice, req("unlock", "pc:sweep")).reply).toBe("ok: pc:sweep rilasciata")
  })
})

describe("memory", () => {
  const at = new Date(2026, 8, 15, 9, 5)

  test("one line per entry, typed and signed", () => {
    expect(memoryEntry("Trappola", "bun test\nsu .tsx non\tcarica", "mario", at)).toEqual({
      line: "- [trappola] bun test su .tsx non carica — mario, 2026-09-15 09:05\n",
    })
    expect("error" in memoryEntry("idea", "x", "mario", at)).toBe(true)
    expect("error" in memoryEntry("fatto", "   ", "mario", at)).toBe(true)
    expect("error" in memoryEntry("fatto", "x".repeat(501), "mario", at)).toBe(true)
  })

  test("the header is written once", () => {
    const first = withMemoryEntry("", "- a\n")
    expect(first).toBe(`${MEMORY_HEADER}- a\n`)
    expect(withMemoryEntry(first, "- b\n")).toBe(`${MEMORY_HEADER}- a\n- b\n`)
  })

  test("a long memory is flagged", () => {
    expect(memoryAddReply("m.md", 10)).not.toContain("attenzione")
    expect(memoryAddReply("m.md", MEMORY_SOFT_LIMIT + 1)).toContain("attenzione")
  })
})

describe("cache stats", () => {
  test("hit rate over the whole prompt", () => {
    expect(cacheHitPercent({ input: 10, cacheRead: 900, cacheWrite: 90, output: 5, requests: 3 })).toBe(90)
    expect(cacheHitPercent({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: 0 })).toBeUndefined()
  })

  test("the table has a row per session and a total", () => {
    const table = statsTable([
      {
        title: "orchestra",
        agent: "claude-code",
        project: "nikcli",
        usage: { input: 100, cacheRead: 9900, cacheWrite: 0, output: 50, requests: 4 },
      },
      {
        title: "worker",
        agent: "codex",
        usage: { input: 1000, cacheRead: 1000, cacheWrite: 0, output: 10, requests: 1 },
      },
    ])
    expect(table).toContain("99%")
    expect(table).toContain("nikcli/orchestra (claude-code)")
    expect(table).toContain("totale")
    expect(statsTable([])).toContain("nessun dato")
  })
})

describe("messages and forks", () => {
  test("kv and memory messages parse", () => {
    expect(parseMessage(JSON.stringify({ from: "p1", kind: "kv", op: "set", key: "k", text: "v" }))).toMatchObject({
      kind: "kv",
      op: "set",
      key: "k",
      text: "v",
      ttl: 0,
    })
    expect(parseMessage(JSON.stringify({ from: "p1", kind: "kv", op: "list", key: "" }))).toMatchObject({
      kind: "kv",
      op: "list",
    })
    expect(parseMessage(JSON.stringify({ from: "p1", kind: "kv", op: "set", key: "k", text: " " }))).toBeUndefined()
    expect(parseMessage(JSON.stringify({ from: "p1", kind: "kv", op: "drop", key: "k" }))).toBeUndefined()
    expect(parseMessage(JSON.stringify({ from: "p1", kind: "kv", op: "lock", key: "k", ttl: 30.7 }))).toMatchObject({
      ttl: 30,
    })
    expect(parseMessage(JSON.stringify({ from: "p1", kind: "memory", op: "show" }))).toMatchObject({
      kind: "memory",
      op: "show",
    })
    expect(
      parseMessage(JSON.stringify({ from: "p1", kind: "memory", op: "add", type: "fatto", text: "x" })),
    ).toMatchObject({ type: "fatto" })
    expect(
      parseMessage(JSON.stringify({ from: "p1", kind: "spawn", agent: "claude", fork: true, text: "t" })),
    ).toMatchObject({ fork: true })
  })

  // Full review 2026-10-06, sessions 17: `isKvKey` accepts the names of Object.prototype.
  test("a key named like a property of Object is an ordinary key", () => {
    for (const key of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      const empty = emptySpace()
      expect(applyKv(empty, req("get", key), alice, 0, everyoneAlive).reply).toMatch(/^errore: nessun valore/)
      expect(applyKv(empty, req("del", key), alice, 0, everyoneAlive).reply).toMatch(/non c'era/)
      expect(applyKv(empty, req("unlock", key), alice, 0, everyoneAlive).reply).toMatch(/non era bloccata/)
      expect(applyKv(empty, req("lock", key), bob, 0, everyoneAlive).reply).toMatch(/^ok/)
      const stored = applyKv(empty, req("set", key, "v"), alice, 0, everyoneAlive)
      expect(stored.reply).toMatch(/^ok/)
      expect(Object.keys(stored.space.entries)).toEqual([key])
      expect(applyKv(stored.space, req("get", key), alice, 0, everyoneAlive).reply).toContain("v")
    }
  })

  test("a saved store with those keys comes back with them as own keys, not as the prototype", () => {
    const raw = '{"p":{"entries":{"__proto__":{"value":"v","by":"a","at":1},"constructor":{"value":"c","by":"a","at":2}},"locks":{}}}'
    const space = parseKvStore(raw).p!
    expect(Object.keys(space.entries).sort()).toEqual(["__proto__", "constructor"])
    expect(({} as Record<string, unknown>).value).toBeUndefined()
    expect(space.entries["constructor"]?.value).toBe("c")
  })

  test("a fork plan for the CLIs that can fork", () => {
    expect(planFork("claude-code", "parent", "child")).toEqual({
      args: ["--resume", "parent", "--fork-session", "--session-id", "child"],
      resumeId: "child",
    })
    expect(planFork("codex", "parent", "child")).toEqual({ args: ["fork", "parent"] })
    expect("error" in planFork("agy", "parent")).toBe(true)
    expect("error" in planFork("claude-code", undefined)).toBe(true)
  })
})
