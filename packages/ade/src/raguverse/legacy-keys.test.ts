import { describe, expect, test } from "bun:test"
import { LEGACY_LOWERED_KEY, LEGACY_PLAYER_KEY, readCopyingLegacy, type KeyStorage } from "./legacy-keys"
import { LOWERED_KEY, createLoweredStore } from "./opening"
import { PLAYER_KEY, createPlayerStore } from "./player"

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  const storage: KeyStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  }
  return { data, storage }
}

describe("the keys from before NikVerse became RaguVerse", () => {
  test("the new names are ade.raguverse.*, the old ones ade.nikverse.*", () => {
    expect([LOWERED_KEY, PLAYER_KEY]).toEqual(["ade.raguverse.lowered", "ade.raguverse.player"])
    expect([LEGACY_LOWERED_KEY, LEGACY_PLAYER_KEY]).toEqual(["ade.nikverse.lowered", "ade.nikverse.player"])
  })

  test("the old value is read and copied once; after that the new key is the only one looked at", () => {
    const { data, storage } = memory({ [LEGACY_PLAYER_KEY]: "old" })
    expect(readCopyingLegacy(storage, PLAYER_KEY, LEGACY_PLAYER_KEY)).toBe("old")
    expect(data.get(PLAYER_KEY)).toBe("old")
    data.set(LEGACY_PLAYER_KEY, "changed later")
    expect(readCopyingLegacy(storage, PLAYER_KEY, LEGACY_PLAYER_KEY)).toBe("old")
    data.set(PLAYER_KEY, "new")
    expect(readCopyingLegacy(storage, PLAYER_KEY, LEGACY_PLAYER_KEY)).toBe("new")
  })

  test("nothing in either is nothing, and a storage that cannot write still gives the old value", () => {
    expect(readCopyingLegacy(memory().storage, PLAYER_KEY, LEGACY_PLAYER_KEY)).toBeNull()
    expect(readCopyingLegacy(undefined, PLAYER_KEY, LEGACY_PLAYER_KEY)).toBeNull()
    const readOnly: KeyStorage = {
      getItem: (key) => (key === LEGACY_PLAYER_KEY ? "old" : null),
      setItem: () => {
        throw new Error("full")
      },
    }
    expect(readCopyingLegacy(readOnly, PLAYER_KEY, LEGACY_PLAYER_KEY)).toBe("old")
  })

  test("the character's place saved under the old key comes back, and is saved under the new one", () => {
    const { data, storage } = memory({ [LEGACY_PLAYER_KEY]: JSON.stringify({ x: 4, z: -9, heading: 1 }) })
    expect(createPlayerStore(storage).load()).toEqual({ x: 4, z: -9, heading: 1 })
    expect(JSON.parse(data.get(PLAYER_KEY)!)).toEqual({ x: 4, z: -9, heading: 1 })
  })

  test("a world lowered under the old key stays lowered, and «riprova» forgets it for good", () => {
    const now = 1_000_000
    const { data, storage } = memory({ [LEGACY_LOWERED_KEY]: JSON.stringify({ at: now }) })
    const store = createLoweredStore(storage, () => now + 1000)
    expect(store.lowered()).toBe(true)
    store.clear()
    expect(data.get(LOWERED_KEY)).toBe("null")
    // The old key is still there, but it is not read again: the lowering does not come back.
    expect(createLoweredStore(storage, () => now + 1000).lowered()).toBe(false)
  })
})
