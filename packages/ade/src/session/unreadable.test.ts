import { describe, expect, test } from "bun:test"
import { serializeWorkspace, type WorkspaceState } from "./persist"
import { MAX_UNREADABLE, WORKSPACE_KEY, keepUnreadable, readSavedWorkspace, unreadableCopies } from "./unreadable"

class FakeStore {
  data = new Map<string, string>()
  full = false
  get length() {
    return this.data.size
  }
  key(i: number) {
    return [...this.data.keys()][i] ?? null
  }
  getItem(k: string) {
    return this.data.get(k) ?? null
  }
  setItem(k: string, v: string) {
    if (this.full) throw new Error("QuotaExceededError")
    this.data.set(k, v)
  }
  removeItem(k: string) {
    this.data.delete(k)
  }
}

const future = JSON.stringify({ version: 99, panes: [{ id: "p1", title: "kept" }] })

describe("readSavedWorkspace", () => {
  test("a workspace from the future is copied aside before anything can write", () => {
    const store = new FakeStore()
    store.setItem(WORKSPACE_KEY, future)
    const saved = readSavedWorkspace(store, 1000)
    expect(saved.state).toBeUndefined()
    expect(saved.unreadable).toBe(true)
    expect(saved.saveBlocked).toBe(false)
    const [copy] = unreadableCopies(store, WORKSPACE_KEY)
    expect(copy).toBe("ade.workspace.unreadable.1000")
    expect(store.getItem(copy!)).toBe(future)
  })

  test("damaged JSON is copied too", () => {
    const store = new FakeStore()
    store.setItem(WORKSPACE_KEY, "{not json")
    expect(readSavedWorkspace(store, 5).unreadable).toBe(true)
    expect(unreadableCopies(store, WORKSPACE_KEY)).toHaveLength(1)
  })

  test("a readable or missing workspace makes no copy and no notice", () => {
    const store = new FakeStore()
    expect(readSavedWorkspace(store, 1)).toEqual({ state: undefined, unreadable: false, saveBlocked: false })
    store.setItem(WORKSPACE_KEY, serializeWorkspace({ version: 4, panes: [], browsers: [], currentView: "sessions", sidebarWidth: 240 } as unknown as WorkspaceState))
    const saved = readSavedWorkspace(store, 2)
    expect(saved.state).toBeDefined()
    expect(saved.unreadable).toBe(false)
    expect(unreadableCopies(store, WORKSPACE_KEY)).toHaveLength(0)
  })

  test("when the copy cannot be made the save stays blocked", () => {
    const store = new FakeStore()
    store.setItem(WORKSPACE_KEY, future)
    store.full = true
    const saved = readSavedWorkspace(store, 1)
    expect(saved.unreadable).toBe(true)
    expect(saved.saveBlocked).toBe(true)
    expect(store.getItem(WORKSPACE_KEY)).toBe(future)
  })

  test("the same unreadable text is not copied again on the next start", () => {
    const store = new FakeStore()
    store.setItem(WORKSPACE_KEY, future)
    readSavedWorkspace(store, 1)
    readSavedWorkspace(store, 2)
    expect(unreadableCopies(store, WORKSPACE_KEY)).toHaveLength(1)
  })
})

describe("keepUnreadable", () => {
  test("keeps the newest three and drops the oldest", () => {
    const store = new FakeStore()
    for (let i = 1; i <= 5; i++) expect(keepUnreadable(store, WORKSPACE_KEY, `v${i}`, i * 10)).toBe(true)
    const copies = unreadableCopies(store, WORKSPACE_KEY)
    expect(copies).toHaveLength(MAX_UNREADABLE)
    expect(copies.map((name) => store.getItem(name))).toEqual(["v3", "v4", "v5"])
  })

  test("a clock set back does not overwrite or misorder", () => {
    const store = new FakeStore()
    keepUnreadable(store, WORKSPACE_KEY, "a", 100)
    keepUnreadable(store, WORKSPACE_KEY, "b", 50)
    expect(unreadableCopies(store, WORKSPACE_KEY).map((name) => store.getItem(name))).toEqual(["a", "b"])
  })
})
