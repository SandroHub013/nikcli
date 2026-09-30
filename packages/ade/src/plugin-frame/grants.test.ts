import { describe, expect, test } from "bun:test"
import {
  GRANTS_KEY,
  REJECTED_KEY,
  SALTS_KEY,
  UNCONFIRMED_KEY,
  addedPermissions,
  createGrantBook,
  createRejectedBook,
  createSaltBook,
  createUnconfirmedBook,
  grantedFor,
  offerable,
  permissionKey,
  unknownPermissions,
  type BookStorage,
} from "./grants"
import { PERMISSIONS } from "./api"

function memory(initial: Record<string, string> = {}): BookStorage & { data: Record<string, string> } {
  const data = { ...initial }
  return { data, getItem: (key) => data[key] ?? null, setItem: (key, value) => void (data[key] = value) }
}

describe("what the user accepted", () => {
  test("nothing is accepted until the user says yes, and a yes is kept for that plugin alone", () => {
    const book = createGrantBook(memory())
    expect(book.accepted("hello")).toEqual([])
    book.accept("hello", ["sessions:read", "storage"])
    expect(book.accepted("hello")).toEqual(["sessions:read", "storage"])
    expect(book.accepted("other")).toEqual([])
  })

  test("an update adds to what was accepted and never takes away", () => {
    const book = createGrantBook(memory())
    book.accept("hello", ["sessions:read"])
    book.accept("hello", ["storage", "sessions:read"])
    expect(book.accepted("hello")).toEqual(["sessions:read", "storage"])
  })

  test("a name that is not a permission is never kept", () => {
    const book = createGrantBook(memory())
    book.accept("hello", ["storage", "root", "__proto__"])
    expect(book.accepted("hello")).toEqual(["storage"])
  })

  test("forget takes them all away (an uninstall)", () => {
    const book = createGrantBook(memory())
    book.accept("hello", ["storage"])
    book.forget("hello")
    expect(book.accepted("hello")).toEqual([])
  })

  test("what is in storage is read defensively: not JSON, not an object, wrong shapes", () => {
    for (const raw of ["", "{", "null", "[]", "3", '"x"', '{"hello":"storage"}', '{"hello":[3,null,"nope"]}']) {
      expect([raw, createGrantBook(memory({ [GRANTS_KEY]: raw })).accepted("hello")]).toEqual([raw, []])
    }
  })

  test("a plugin id of __proto__ cannot pollute anything", () => {
    const book = createGrantBook(memory())
    book.accept("__proto__", ["storage"])
    expect(({} as { storage?: unknown }).storage).toBeUndefined()
    expect(book.accepted("__proto__")).toEqual(["storage"])
    expect(book.accepted("constructor")).toEqual([])
  })

  test("a storage that throws is a plugin with nothing accepted, and a save that fails asks again next time", () => {
    const broken: BookStorage = {
      getItem() {
        throw new Error("blocked")
      },
      setItem() {
        throw new Error("full")
      },
    }
    const book = createGrantBook(broken)
    expect(book.accepted("hello")).toEqual([])
    expect(() => book.accept("hello", ["storage"])).not.toThrow()
    expect(createGrantBook(undefined).accepted("hello")).toEqual([])
  })
})

describe("what a running plugin is granted", () => {
  test("what its manifest asks for and the user accepted, and nothing else", () => {
    expect(grantedFor(["storage", "sessions:read"], ["sessions:read"])).toEqual(["sessions:read"])
    expect(grantedFor(["storage"], ["sessions:read"])).toEqual([])
    expect(grantedFor([], ["sessions:read"])).toEqual([])
  })

  test("a manifest that names something ADE does not know grants nothing for it", () => {
    expect(grantedFor(["root", "storage"], ["storage"])).toEqual(["storage"])
    expect(unknownPermissions(["root", "storage", "root"])).toEqual(["root"])
  })

  test("an update that asks for one permission more adds only that one to the question", () => {
    expect(addedPermissions(["sessions:read", "storage", "pane:focus"], ["sessions:read", "storage"])).toEqual(["pane:focus"])
    expect(addedPermissions(["storage"], ["storage", "sessions:read"])).toEqual([])
    expect(addedPermissions(["storage", "nope"], [])).toEqual(["storage"])
  })

  test("every permission has words of its own", () => {
    expect(new Set(PERMISSIONS.map(permissionKey)).size).toBe(PERMISSIONS.length)
  })
})

describe("the versions that did not start", () => {
  test("a version taken back is remembered for that plugin, and offered no more", () => {
    const book = createRejectedBook(memory())
    expect(book.has("hello", "1.1.0")).toBe(false)
    book.add("hello", "1.1.0")
    expect(book.has("hello", "1.1.0")).toBe(true)
    expect(book.has("hello", "1.2.0")).toBe(false)
    expect(book.has("other", "1.1.0")).toBe(false)
    book.forget("hello")
    expect(book.has("hello", "1.1.0")).toBe(false)
  })

  test("it keeps the last eight and does not grow without end", () => {
    const store = memory()
    const book = createRejectedBook(store)
    for (let i = 0; i < 30; i++) book.add("hello", `1.${i}.0`)
    expect(JSON.parse(store.data[REJECTED_KEY]!).hello).toHaveLength(8)
    expect(book.has("hello", "1.29.0")).toBe(true)
    expect(book.has("hello", "1.0.0")).toBe(false)
  })

  test("a check offers a version unless it was taken back or there is nothing to download", () => {
    const rejected = (version: string) => version === "1.1.0"
    expect(offerable({ version: "1.2.0", update: true }, rejected)).toEqual({ version: "1.2.0", update: true })
    expect(offerable({ version: "1.1.0", update: true }, rejected)).toBeUndefined()
    expect(offerable({ version: "1.2.0", update: false }, rejected)).toBeUndefined()
  })
})

describe("the salt of each plugin", () => {
  test("made once, kept, and different for each plugin", () => {
    let n = 0
    const book = createSaltBook(memory(), () => `salt-number-${n++}-`.padEnd(20, "0"))
    const first = book.of("hello")
    expect(book.of("hello")).toBe(first)
    expect(book.of("other")).not.toBe(first)
  })

  test("forgotten with the plugin, and a new one is made after", () => {
    let n = 0
    const store = memory()
    const book = createSaltBook(store, () => `salt-number-${n++}-`.padEnd(20, "0"))
    const first = book.of("hello")
    book.forget("hello")
    expect(book.of("hello")).not.toBe(first)
    expect(store.data[SALTS_KEY]).toBeDefined()
  })

  test("a salt that was tampered with into something short is replaced", () => {
    const book = createSaltBook(memory({ [SALTS_KEY]: '{"hello":"x"}' }))
    expect(book.of("hello").length).toBeGreaterThanOrEqual(16)
  })

  test("with no storage at all it still gives a salt, a different one each time", () => {
    const book = createSaltBook(undefined)
    expect(book.of("hello")).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe("the version that was committed and has not said ready", () => {
  test("written at the commit, read back for that plugin alone, and cleared by ready", () => {
    const book = createUnconfirmedBook(memory())
    expect(book.get("hello")).toBeUndefined()
    book.set("hello", "1.1.0", true)
    expect(book.get("hello")).toEqual({ version: "1.1.0", hadEarlier: true })
    expect(book.get("other")).toBeUndefined()
    book.clear("hello")
    expect(book.get("hello")).toBeUndefined()
  })

  test("a newer commit replaces the older one", () => {
    const book = createUnconfirmedBook(memory())
    book.set("hello", "1.1.0", true)
    book.set("hello", "1.2.0", false)
    expect(book.get("hello")).toEqual({ version: "1.2.0", hadEarlier: false })
  })

  test("what was tampered with into something that is not a version is ignored", () => {
    const storage = memory({ [UNCONFIRMED_KEY]: JSON.stringify({ a: "1.0.0", b: { version: 7, hadEarlier: true }, c: { version: "1.0.0" }, d: { version: "", hadEarlier: true }, e: { version: "x".repeat(65), hadEarlier: true }, f: null }) })
    const book = createUnconfirmedBook(storage)
    for (const id of ["a", "b", "c", "d", "e", "f"]) expect(book.get(id)).toBeUndefined()
  })

  test("an id of __proto__ is a key like any other, and clearing one that is not there writes nothing", () => {
    const storage = memory()
    const book = createUnconfirmedBook(storage)
    book.clear("hello")
    expect(storage.data[UNCONFIRMED_KEY]).toBeUndefined()
    book.set("__proto__", "1.0.0", true)
    expect(book.get("__proto__")).toEqual({ version: "1.0.0", hadEarlier: true })
    expect(({} as Record<string, unknown>).version).toBeUndefined()
  })

  test("with no storage, or a storage that throws, it forgets and does not crash", () => {
    const none = createUnconfirmedBook(undefined)
    none.set("hello", "1.0.0", true)
    expect(none.get("hello")).toBeUndefined()
    const broken = createUnconfirmedBook({
      getItem: () => {
        throw new Error("blocked")
      },
      setItem: () => {
        throw new Error("full")
      },
    })
    broken.set("hello", "1.0.0", true)
    expect(broken.get("hello")).toBeUndefined()
    broken.clear("hello")
  })
})
