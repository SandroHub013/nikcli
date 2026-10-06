import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { parseMemory, localMemoryStore } from "./memory"
import { localRoomStore, type RoomBook } from "./room-app"
import { EMPTY_BOOK, localRoutineStore, type RoutineBook } from "./routine"

/*
 * Full review 2026-10-06, bots 3: the thread archive fills localStorage to its limit, and then
 * the routines' `setItem` fails. `get` read the old book back from storage (a read does not
 * throw), so `lastRunAt`, `runs` and `spentUsd` were never kept and a routine with a daily cap
 * was due again at the next tick: paid runs with no cap. The rooms and the memory had the same
 * shape. A write that did not land is kept in memory, and memory answers until one lands.
 */

const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")

/** A localStorage whose writes fail while `full` holds. */
function fakeStorage() {
  const items = new Map<string, string>()
  const state = { full: false, writes: 0 }
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      state.writes++
      if (state.full) throw new DOMException("The quota has been exceeded.", "QuotaExceededError")
      items.set(key, value)
    },
    removeItem: (key: string) => void items.delete(key),
  }
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true })
  return { items, state }
}

beforeEach(() => {
  fakeStorage()
})
afterEach(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original)
  else delete (globalThis as { localStorage?: unknown }).localStorage
})

describe("a store whose write does not land", () => {
  test("the routines' book: what was set is what is read, not the book before", () => {
    const { state } = fakeStorage()
    const store = localRoutineStore("test.routines")
    const ran: RoutineBook = {
      ...EMPTY_BOOK,
      logs: { r1: { lastRunAt: 1000, day: "2026-10-06", runs: 3, spentUsd: 0.5 } },
    }
    store.set(EMPTY_BOOK)
    state.full = true
    store.set(ran)
    // Before: parseBook(storage) answered, with the book from before the run.
    expect(store.get()).toBe(ran)
    expect(store.get().logs["r1"]?.runs).toBe(3)
  })

  test("a later write that lands is what storage answers again", () => {
    const { state } = fakeStorage()
    const store = localRoutineStore("test.routines")
    const first: RoutineBook = { ...EMPTY_BOOK, logs: { r1: { lastRunAt: 1, runs: 1, spentUsd: 0 } } }
    const second: RoutineBook = { ...EMPTY_BOOK, logs: { r1: { lastRunAt: 2, runs: 2, spentUsd: 0 } } }
    state.full = true
    store.set(first)
    expect(store.get()).toBe(first)
    state.full = false
    store.set(second)
    // Storage is the source again; the routine r1 is not in the book, so only the shape is checked.
    expect(store.get()).not.toBe(first)
    expect(store.get()).toEqual(EMPTY_BOOK)
  })

  test("the rooms: a message just written is not taken back", () => {
    const { state } = fakeStorage()
    const store = localRoomStore("test.rooms")
    const room = { id: "room-1", name: "Redazione", members: [], messages: [{ text: "ciao" }] } as never
    const book: RoomBook = { rooms: [room] }
    store.set({ rooms: [] })
    state.full = true
    store.set(book)
    expect(store.get()).toBe(book)
  })

  test("a bot's memory: a note just kept is not lost", () => {
    const { state } = fakeStorage()
    const store = localMemoryStore("test.memory")
    const memory = parseMemory({ notes: ["l'utente preferisce l'italiano"] })
    store.set("C:/bots/a.md", parseMemory({}))
    state.full = true
    store.set("C:/bots/a.md", memory)
    expect(store.get("C:/bots/a.md").notes).toEqual(["l'utente preferisce l'italiano"])
    // Another bot is read from storage as it always was.
    expect(store.get("C:/bots/b.md").notes).toEqual([])
  })
})
