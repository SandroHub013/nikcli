import { describe, expect, test } from "bun:test"
import { createLink, type LinkPort } from "./link"
import { MAX_DISTANCE, PLAYER_KEY, createPlayerStore, readSpot, type PlayerSpot, type SpotStorage } from "./player"
import { readFromWorld, type ToWorld } from "./protocol"

const memoryStorage = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial))
  const storage: SpotStorage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
  return { storage, data }
}

describe("a spot from the world", () => {
  test("three finite numbers within the city are a spot", () => {
    expect(readSpot({ x: 1.5, z: -2, heading: 3 })).toEqual({ x: 1.5, z: -2, heading: 3 })
    expect(readSpot({ x: 0, z: 0, heading: 0, extra: "ignored" })).toEqual({ x: 0, z: 0, heading: 0 })
  })

  test("anything else is nothing: not numbers, not finite, absurdly far", () => {
    for (const bad of [
      null,
      undefined,
      "x",
      3,
      [],
      {},
      { x: 1, z: 2 },
      { x: "1", z: 2, heading: 0 },
      { x: NaN, z: 0, heading: 0 },
      { x: Infinity, z: 0, heading: 0 },
      { x: 0, z: -Infinity, heading: 0 },
      { x: 0, z: 0, heading: NaN },
      { x: MAX_DISTANCE + 1, z: 0, heading: 0 },
      { x: 0, z: -MAX_DISTANCE - 1, heading: 0 },
      { x: 0, z: 0, heading: 1e9 },
    ])
      expect([bad, readSpot(bad)]).toEqual([bad, undefined])
  })

  test("the message the world sends is read as a position, and a bad one is dropped like any unknown message", () => {
    expect(readFromWorld({ type: "position", x: 1, z: 2, heading: 0.5 })).toEqual({ type: "position", x: 1, z: 2, heading: 0.5 })
    expect(readFromWorld({ type: "position", x: 1, z: 2 })).toBeUndefined()
    expect(readFromWorld({ type: "position", x: 1e6, z: 2, heading: 0 })).toBeUndefined()
    expect(readFromWorld({ type: "position", x: "1", z: 2, heading: 0 })).toBeUndefined()
  })
})

describe("ADE keeps the place", () => {
  test("it is kept in ADE's storage and comes back in a new store, as it was saved", () => {
    const { storage, data } = memoryStorage()
    createPlayerStore(storage).save({ x: 4, z: -9, heading: 1 })
    expect(JSON.parse(data.get(PLAYER_KEY)!)).toEqual({ x: 4, z: -9, heading: 1 })
    expect(createPlayerStore(storage).load()).toEqual({ x: 4, z: -9, heading: 1 })
  })

  test("on a first visit there is no place, and saved garbage is no place either", () => {
    expect(createPlayerStore(memoryStorage().storage).load()).toBeUndefined()
    for (const garbage of ["not json", "{}", '{"x":"a"}', "null", '{"x":1,"z":2,"heading":"n"}'])
      expect(createPlayerStore(memoryStorage({ [PLAYER_KEY]: garbage }).storage).load()).toBeUndefined()
  })

  test("a bad spot is not saved over a good one", () => {
    const { storage, data } = memoryStorage()
    const store = createPlayerStore(storage)
    store.save({ x: 1, z: 1, heading: 0 })
    store.save({ x: NaN, z: 0, heading: 0 })
    store.save({ x: 9999, z: 0, heading: 0 })
    expect(store.load()).toEqual({ x: 1, z: 1, heading: 0 })
    expect(JSON.parse(data.get(PLAYER_KEY)!)).toEqual({ x: 1, z: 1, heading: 0 })
  })

  test("with no storage, or storage that throws, the place is kept in memory for the session", () => {
    const none = createPlayerStore(undefined)
    none.save({ x: 2, z: 3, heading: 0 })
    expect(none.load()).toEqual({ x: 2, z: 3, heading: 0 })
    const broken: SpotStorage = {
      getItem: () => {
        throw new Error("blocked")
      },
      setItem: () => {
        throw new Error("blocked")
      },
    }
    const store = createPlayerStore(broken)
    expect(store.load()).toBeUndefined()
    store.save({ x: 5, z: 5, heading: 0 })
    expect(store.load()).toEqual({ x: 5, z: 5, heading: 0 })
  })
})

describe("the link between them", () => {
  function rig(player?: () => PlayerSpot | undefined) {
    const sent: ToWorld[] = []
    const saved: PlayerSpot[] = []
    const port: LinkPort = { postMessage: (m) => void sent.push(m), close() {} }
    const link = createLink({
      port,
      picture: () => ({ at: 1, shops: [], agents: [], waiting: { decisions: 0 } }),
      run() {},
      ask() {},
      ignored() {},
      schedule: () => () => {},
      player,
      savePlayer: (spot) => void saved.push(spot),
    })
    return { link, sent, saved }
  }

  test("when the world says ready it is told where the character stood, before the picture", () => {
    const { link, sent } = rig(() => ({ x: 3, z: -4, heading: 2 }))
    link.receive({ type: "ready" })
    expect(sent.map((m) => m.type)).toEqual(["player", "snapshot"])
    expect(sent[0]).toEqual({ type: "player", x: 3, z: -4, heading: 2 })
  })

  test("on a first visit there is no place to give, and the picture goes as before", () => {
    const { link, sent } = rig(() => undefined)
    link.receive({ type: "ready" })
    expect(sent.map((m) => m.type)).toEqual(["snapshot"])
    const bare = rig()
    bare.link.receive({ type: "ready" })
    expect(bare.sent.map((m) => m.type)).toEqual(["snapshot"])
  })

  test("a position from the world is kept, and a bad one is not", () => {
    const { link, saved } = rig()
    link.receive({ type: "position", x: 1, z: 2, heading: 3 })
    link.receive({ type: "position", x: "1", z: 2, heading: 3 })
    link.receive({ type: "position", x: 5000, z: 2, heading: 3 })
    expect(saved).toEqual([{ x: 1, z: 2, heading: 3 }])
  })

  test("a position is not a command: it asks ADE for nothing and changes what the world may ask", () => {
    const { link, sent } = rig()
    link.receive({ type: "position", x: 1, z: 2, heading: 3 })
    expect(sent).toEqual([])
    // Nothing was shown yet, so a command about anything is still refused.
    link.receive({ type: "command", command: { cmd: "open-session", paneId: "p" } })
    expect(sent).toEqual([])
  })
})
