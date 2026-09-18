import { describe, expect, test } from "bun:test"
import { createHaltStore, readHalt, VOICE_HALT_STORAGE_KEY } from "./halt"

const memory = () => {
  const store = new Map<string, string>()
  return {
    store,
    storage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    } as unknown as Storage,
  }
}

describe("listening that stopped itself is still stopped tomorrow", () => {
  test("the reason and the moment are kept, and read back on the next launch", () => {
    const { store, storage } = memory()
    createHaltStore(storage).write({ reason: "Ho smesso di ascoltare: troppe frasi.", at: 1_000 })
    expect(JSON.parse(store.get(VOICE_HALT_STORAGE_KEY)!)).toMatchObject({ at: 1_000 })
    expect(createHaltStore(storage).read()).toMatchObject({ reason: "Ho smesso di ascoltare: troppe frasi.", at: 1_000 })
  })

  test("the user starting it again clears it, for good", () => {
    const { store, storage } = memory()
    const halts = createHaltStore(storage)
    halts.write({ reason: "basta", at: 1 })
    halts.clear()
    expect(halts.read()).toBeUndefined()
    expect(store.has(VOICE_HALT_STORAGE_KEY)).toBe(false)
    expect(createHaltStore(storage).read()).toBeUndefined()
  })

  test("nothing stored, or something that is not a halt, is no halt at all", () => {
    expect(readHalt(null)).toBeUndefined()
    expect(readHalt("non è json")).toBeUndefined()
    expect(readHalt(JSON.stringify({ at: 5 }))).toBeUndefined()
    expect(readHalt(JSON.stringify({ reason: "   " }))).toBeUndefined()
    expect(readHalt(JSON.stringify({ reason: "basta" }))).toMatchObject({ reason: "basta", at: 0 })
  })

  test("a storage that refuses is not a reason to stop working", () => {
    const refused = {
      getItem: () => {
        throw new Error("no")
      },
      setItem: () => {
        throw new Error("no")
      },
      removeItem: () => {
        throw new Error("no")
      },
    } as unknown as Storage
    const halts = createHaltStore(refused)
    halts.write({ reason: "basta", at: 1 })
    expect(halts.read()).toMatchObject({ reason: "basta" })
    halts.clear()
    expect(halts.read()).toBeUndefined()
    expect(createHaltStore(null).read()).toBeUndefined()
  })
})
