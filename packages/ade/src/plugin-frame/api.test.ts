import { describe, expect, test } from "bun:test"
import {
  API_VERSION,
  MAX_MESSAGES_PER_SECOND,
  MAX_STORAGE_BYTES,
  PERMISSIONS,
  REQUESTS,
  authorize,
  createRateLimit,
  envelope,
  knownPermissions,
  parseIncoming,
  storable,
} from "./api"

const msg = (over: Record<string, unknown>) => ({ v: 1, ...over })

describe("parseIncoming: the schema of a message from the plugin", () => {
  test("ready and pong are read", () => {
    expect(parseIncoming(msg({ type: "ready" }))).toEqual({ ok: true, incoming: { kind: "ready" } })
    expect(parseIncoming(msg({ type: "pong", id: 4 }))).toEqual({ ok: true, incoming: { kind: "pong", id: 4 } })
  })

  test("every request of the table is read, with its id", () => {
    const rows: [Record<string, unknown>, unknown][] = [
      [{ type: "sessions.snapshot", id: 1 }, { name: "sessions.snapshot" }],
      [{ type: "projects", id: 2 }, { name: "projects" }],
      [{ type: "decisions.count", id: 3 }, { name: "decisions.count" }],
      [{ type: "pane.focus", id: 4, paneId: "p1" }, { name: "pane.focus", paneId: "p1" }],
      [
        { type: "command.run", id: 5, chord: { key: "p", ctrl: true, alt: false, shift: true, meta: false } },
        { name: "command.run", chord: { key: "p", ctrl: true, alt: false, shift: true, meta: false } },
      ],
      [{ type: "focus.release", id: 6 }, { name: "focus.release" }],
      [{ type: "storage.get", id: 7 }, { name: "storage.get" }],
      [{ type: "storage.set", id: 8, value: { a: 1 } }, { name: "storage.set", value: { a: 1 } }],
    ]
    for (const [body, request] of rows) {
      expect(parseIncoming(msg(body))).toEqual({ ok: true, incoming: { kind: "request", id: body.id as number, request } as never })
    }
    // Every request of the table has a row here, and none is missing from `REQUESTS`.
    expect(rows.map(([body]) => body.type).sort()).toEqual(Object.keys(REQUESTS).sort())
  })

  test("a request may have a string id, or none", () => {
    expect(parseIncoming(msg({ type: "focus.release", id: "abc" }))).toMatchObject({ ok: true, incoming: { id: "abc" } })
    expect(parseIncoming(msg({ type: "focus.release" }))).toEqual({
      ok: true,
      incoming: { kind: "request", id: undefined, request: { name: "focus.release" } },
    })
  })

  test("a message that is not an object, or has no version or another one, is refused", () => {
    for (const raw of [null, undefined, "ready", 3, [], [{ type: "ready" }], true]) {
      expect(parseIncoming(raw).ok).toBe(false)
    }
    for (const raw of [{ type: "ready" }, { v: 2, type: "ready" }, { v: "1", type: "ready" }, { v: null, type: "ready" }]) {
      expect(parseIncoming(raw)).toMatchObject({ ok: false })
    }
  })

  test("a message with no type, or a type that is not text, is refused", () => {
    for (const raw of [msg({}), msg({ type: 3 }), msg({ type: null }), msg({ type: ["ready"] }), msg({ type: {} })]) {
      expect(parseIncoming(raw).ok).toBe(false)
    }
  })

  test("an unknown type is refused with its name, and keeps the id so the answer can carry it", () => {
    const parsed = parseIncoming(msg({ type: "sessions.close", id: 9 }))
    expect(parsed).toEqual({ ok: false, reason: "messaggio sconosciuto: sessions.close", id: 9 })
  })

  test("__proto__, constructor and the other names every object has are not requests", () => {
    for (const type of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "prototype"]) {
      const parsed = parseIncoming(msg({ type, id: 1 }))
      expect([type, parsed.ok]).toEqual([type, false])
    }
    // Made the way a hostile page would: `__proto__` as an own key of the message.
    const hostile = JSON.parse('{"v":1,"type":"storage.set","__proto__":{"polluted":true},"value":1}')
    expect(parseIncoming(hostile).ok).toBe(true)
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })

  test("a name is cut in the reason: a page cannot make ADE log a book", () => {
    const parsed = parseIncoming(msg({ type: "x".repeat(10_000) }))
    expect(!parsed.ok && parsed.reason.length).toBeLessThan(100)
  })

  test("malformed arguments are refused, each on its own", () => {
    const bad: Record<string, unknown>[] = [
      { type: "pane.focus" },
      { type: "pane.focus", paneId: "" },
      { type: "pane.focus", paneId: 3 },
      { type: "pane.focus", paneId: "x".repeat(201) },
      { type: "pong" },
      { type: "pong", id: "1" },
      { type: "storage.set" },
      { type: "command.run" },
      { type: "command.run", chord: null },
      { type: "command.run", chord: { key: "p" } },
      { type: "command.run", chord: { key: "p", ctrl: 1, alt: false, shift: false, meta: false } },
      { type: "command.run", chord: { key: "", ctrl: true, alt: false, shift: false, meta: false } },
      { type: "command.run", chord: { key: "x".repeat(25), ctrl: true, alt: false, shift: false, meta: false } },
      // A bare key, or only Shift: the plugin's own, and ADE's shortcuts all have a modifier.
      { type: "command.run", chord: { key: "p", ctrl: false, alt: false, shift: true, meta: false } },
    ]
    for (const body of bad) {
      const parsed = parseIncoming(msg(body))
      expect([body, parsed.ok]).toEqual([body, false])
    }
  })

  test("an id that is not a small integer or a short text is dropped, not trusted", () => {
    for (const id of [1.5, Number.MAX_VALUE, NaN, {}, [], "x".repeat(65), ""]) {
      const parsed = parseIncoming(msg({ type: "nope", id }))
      expect([id, parsed.ok && 0, !parsed.ok && parsed.id]).toEqual([id, false, undefined])
    }
  })
})

describe("authorize: the permission of each request", () => {
  test("a request with its permission goes on; without it, it says which one is missing", () => {
    for (const name of Object.keys(REQUESTS) as (keyof typeof REQUESTS)[]) {
      const needed = REQUESTS[name].permission
      if (!needed) {
        expect(authorize(name, [])).toBeUndefined()
        continue
      }
      expect(authorize(name, [needed])).toBeUndefined()
      expect(authorize(name, [])).toBe(`permesso mancante: ${needed}`)
      // Another permission does not stand in for it.
      const other = PERMISSIONS.find((permission) => permission !== needed)!
      expect(authorize(name, [other])).toBe(`permesso mancante: ${needed}`)
    }
  })

  test("focus.release needs none, and everything else needs exactly one of the six", () => {
    expect(REQUESTS["focus.release"].permission).toBeUndefined()
    const needed = Object.values(REQUESTS).flatMap((request) => (request.permission ? [request.permission] : []))
    expect([...new Set(needed)].sort()).toEqual([...PERMISSIONS].sort())
  })

  test("knownPermissions keeps the ones ADE knows, once, and grants nothing for the rest", () => {
    expect(knownPermissions(["storage", "storage", "root", 3, "sessions:read", "sessions:write"])).toEqual(["storage", "sessions:read"])
    expect(knownPermissions(["__proto__", "constructor"])).toEqual([])
  })
})

describe("storable: what storage.set keeps", () => {
  test("JSON is kept as JSON", () => {
    expect(storable({ a: [1, 2, { b: null }] })).toEqual({ ok: true, json: '{"a":[1,2,{"b":null}]}' })
    expect(storable(0)).toEqual({ ok: true, json: "0" })
  })

  test("what is not JSON is refused: undefined, a function, a cycle, a BigInt", () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    for (const value of [undefined, () => 1, cycle, 10n]) expect(storable(value).ok).toBe(false)
  })

  test("the ceiling is 1 MB of JSON, counted in bytes, not characters", () => {
    expect(storable("a".repeat(MAX_STORAGE_BYTES - 2)).ok).toBe(true)
    expect(storable("a".repeat(MAX_STORAGE_BYTES - 1)).ok).toBe(false)
    // Two bytes each in UTF-8: half as many characters reach the ceiling.
    expect(storable("è".repeat(MAX_STORAGE_BYTES / 2)).ok).toBe(false)
  })
})

describe("createRateLimit: 50 messages a second", () => {
  const rig = () => {
    let now = 1000
    return { limit: createRateLimit(() => now), at: (ms: number) => void (now = ms) }
  }

  test("the first 50 of a second go on, the 51st is the first drop, and every one after is a plain drop", () => {
    const { limit } = rig()
    const seen = Array.from({ length: MAX_MESSAGES_PER_SECOND + 5 }, () => limit.admit())
    expect(seen.slice(0, 50).every((verdict) => verdict === "ok")).toBe(true)
    expect(seen.slice(50)).toEqual(["first-drop", "drop", "drop", "drop", "drop"])
  })

  test("a new second starts again, and warns again if it is flooded again", () => {
    const { limit, at } = rig()
    for (let i = 0; i < 60; i++) limit.admit()
    at(2000)
    expect(limit.admit()).toBe("ok")
    for (let i = 0; i < 49; i++) limit.admit()
    expect(limit.admit()).toBe("first-drop")
  })

  test("a message just inside the second still counts in it", () => {
    const { limit, at } = rig()
    for (let i = 0; i < 50; i++) limit.admit()
    at(1999)
    expect(limit.admit()).toBe("first-drop")
  })

  test("a clock that goes back does not lock the plugin out", () => {
    const { limit, at } = rig()
    for (let i = 0; i < 60; i++) limit.admit()
    at(10)
    expect(limit.admit()).toBe("ok")
  })
})

describe("envelope", () => {
  test("everything ADE sends carries the version", () => {
    expect(envelope({ type: "pause" })).toEqual({ v: API_VERSION, type: "pause" })
    expect(envelope({ type: "reply", id: 1, ok: true, value: 2 })).toEqual({ v: 1, type: "reply", id: 1, ok: true, value: 2 })
  })
})
