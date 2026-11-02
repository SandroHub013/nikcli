import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { serializeWorkspace, unreadableReason, type WorkspaceState } from "./persist"
import {
  MAX_UNREADABLE,
  WORKSPACE_KEY,
  keepUnreadable,
  readSavedWorkspace,
  restorableCopy,
  ignoreRestore,
  ignoredCopies,
  restoreCopy,
  retryUnreadableCopy,
  unreadableCopies,
} from "./unreadable"

class FakeStore {
  data = new Map<string, string>()
  full = false
  /** Room for this many characters in all; 0 = unlimited. */
  room = 0
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
    if (this.room) {
      let used = v.length
      for (const [name, text] of this.data) if (name !== k) used += text.length
      if (used > this.room) throw new Error("QuotaExceededError")
    }
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

describe("when there is little room", () => {
  test("the oldest copy goes before the new one is written, so a full store still takes it", () => {
    const store = new FakeStore()
    const text = "x".repeat(100)
    for (let i = 1; i <= MAX_UNREADABLE; i++) store.setItem(`${WORKSPACE_KEY}.unreadable.${i}`, `${i}${text}`)
    store.room = text.length * 4 + 20
    expect(keepUnreadable(store, WORKSPACE_KEY, `new${text}`, 99)).toBe(true)
    expect(unreadableCopies(store, WORKSPACE_KEY)).toHaveLength(MAX_UNREADABLE)
    expect(store.getItem(`${WORKSPACE_KEY}.unreadable.99`)).toBe(`new${text}`)
  })

  test("with no room even then, the other old copies go and it is tried once more", () => {
    const store = new FakeStore()
    const text = "y".repeat(100)
    store.setItem(`${WORKSPACE_KEY}.unreadable.1`, `a${text}`)
    store.setItem(`${WORKSPACE_KEY}.unreadable.2`, `b${text}`)
    store.room = text.length * 2 + 10
    expect(keepUnreadable(store, WORKSPACE_KEY, `c${text}`, 5)).toBe(true)
    expect(unreadableCopies(store, WORKSPACE_KEY).map((name) => store.getItem(name)?.[0])).toEqual(["c"])
  })

  test("a blocked save is tried again and lets go once the copy exists", () => {
    const store = new FakeStore()
    store.setItem(WORKSPACE_KEY, future)
    store.full = true
    expect(readSavedWorkspace(store, 1).saveBlocked).toBe(true)
    expect(retryUnreadableCopy(store, 2)).toBe(false)
    store.full = false
    expect(retryUnreadableCopy(store, 3)).toBe(true)
    expect(unreadableCopies(store, WORKSPACE_KEY)).toHaveLength(1)
  })

  test("nothing to protect: the retry lets the save go on", () => {
    const store = new FakeStore()
    expect(retryUnreadableCopy(store, 1)).toBe(true)
    store.setItem(WORKSPACE_KEY, serializeWorkspace(readable([])))
    expect(retryUnreadableCopy(store, 2)).toBe(true)
  })
})

function readable(panes: unknown[]): WorkspaceState {
  return { version: 4, panes, browsers: [], currentView: "sessions", sidebarWidth: 240 } as unknown as WorkspaceState
}

/*
 * Roll back, go forward: the old build copied the sessions and saved an empty workbench; the new build reads the empty
 * one fine. The copy is offered back, and put back only when asked for.
 */
describe("getting the sessions back", () => {
  const sessions = (version: number) =>
    JSON.stringify({ version, panes: [{ id: "p1", title: "kept", status: "idle" }], browsers: [] })

  test("a kept copy that reads now is offered, newest first, and empty ones are not", () => {
    const store = new FakeStore()
    const older = serializeWorkspace(readable([{ id: "p0", title: "old", status: "idle" }]))
    store.setItem(`${WORKSPACE_KEY}.unreadable.1`, older)
    store.setItem(`${WORKSPACE_KEY}.unreadable.2`, serializeWorkspace(readable([])))
    store.setItem(`${WORKSPACE_KEY}.unreadable.3`, future)
    expect(restorableCopy(store)?.key).toBe(`${WORKSPACE_KEY}.unreadable.1`)
  })

  test("nothing is offered while the copies still cannot be read", () => {
    const store = new FakeStore()
    store.setItem(`${WORKSPACE_KEY}.unreadable.1`, future)
    expect(restorableCopy(store)).toBeUndefined()
  })

  test("restoring writes the copy as the workspace and drops the copy; reading it back has the sessions", () => {
    const store = new FakeStore()
    store.setItem(WORKSPACE_KEY, serializeWorkspace(readable([])))
    store.setItem(`${WORKSPACE_KEY}.unreadable.1`, serializeWorkspace(readable([{ id: "p1", title: "kept", status: "idle" }])))
    const copy = restorableCopy(store)!
    expect(readSavedWorkspace(store, 9).state?.panes).toHaveLength(0)
    expect(restoreCopy(store, copy.key)).toBe(true)
    expect(unreadableCopies(store, WORKSPACE_KEY)).toHaveLength(0)
    expect(readSavedWorkspace(store, 10).state?.panes).toHaveLength(1)
  })

  test("a copy that no longer reads is not put over the workspace", () => {
    const store = new FakeStore()
    const good = serializeWorkspace(readable([{ id: "p1", title: "now", status: "idle" }]))
    store.setItem(WORKSPACE_KEY, good)
    store.setItem(`${WORKSPACE_KEY}.unreadable.1`, sessions(99))
    expect(restoreCopy(store, `${WORKSPACE_KEY}.unreadable.1`)).toBe(false)
    expect(store.getItem(WORKSPACE_KEY)).toBe(good)
  })
})

describe("«Ignora» on the offer", () => {
  const copyOf = (title: string) => serializeWorkspace(readable([{ id: "p", title, status: "idle" }]))

  test("an ignored copy is not offered again, and it is still there", () => {
    const store = new FakeStore()
    store.setItem(`${WORKSPACE_KEY}.unreadable.1`, copyOf("one"))
    expect(restorableCopy(store)?.key).toBe(`${WORKSPACE_KEY}.unreadable.1`)
    ignoreRestore(store, `${WORKSPACE_KEY}.unreadable.1`)
    expect(restorableCopy(store)).toBeUndefined()
    expect(store.getItem(`${WORKSPACE_KEY}.unreadable.1`)).toBe(copyOf("one"))
  })

  test("the next older copy that reads is offered instead", () => {
    const store = new FakeStore()
    store.setItem(`${WORKSPACE_KEY}.unreadable.1`, copyOf("older"))
    store.setItem(`${WORKSPACE_KEY}.unreadable.2`, copyOf("newer"))
    ignoreRestore(store, `${WORKSPACE_KEY}.unreadable.2`)
    expect(restorableCopy(store)?.key).toBe(`${WORKSPACE_KEY}.unreadable.1`)
  })

  test("a copy that the rotation dropped is forgotten, and a new one is offered", () => {
    const store = new FakeStore()
    store.setItem(`${WORKSPACE_KEY}.unreadable.1`, copyOf("one"))
    ignoreRestore(store, `${WORKSPACE_KEY}.unreadable.1`)
    store.removeItem(`${WORKSPACE_KEY}.unreadable.1`)
    expect(ignoredCopies(store)).toEqual([])
    store.setItem(`${WORKSPACE_KEY}.unreadable.2`, copyOf("two"))
    expect(restorableCopy(store)?.key).toBe(`${WORKSPACE_KEY}.unreadable.2`)
  })

  test("the memory of what was ignored is not itself taken for a copy", () => {
    const store = new FakeStore()
    store.setItem(`${WORKSPACE_KEY}.unreadable.1`, copyOf("one"))
    ignoreRestore(store, `${WORKSPACE_KEY}.unreadable.1`)
    expect(unreadableCopies(store, WORKSPACE_KEY)).toEqual([`${WORKSPACE_KEY}.unreadable.1`])
  })
})

/*
 * Live test 2026-11-02, F3: a truncated `ade.workspace` got the notice «aggiorna ADE per riaverle», which cannot help:
 * the text is broken and no version will read it. A newer version's text is the one updating cures.
 */
describe("why a saved workspace does not read", () => {
  test("damage is not a newer version: the two are told apart", () => {
    expect(unreadableReason("{not json")).toBe("broken")
    expect(unreadableReason(future.slice(0, future.length / 2))).toBe("broken")
    expect(unreadableReason("[1,2]")).toBe("broken")
    expect(unreadableReason('"text"')).toBe("broken")
    expect(unreadableReason(future)).toBe("newer")
  })

  test("the boot is told the reason, and where the copy is", () => {
    const broken = new FakeStore()
    broken.setItem(WORKSPACE_KEY, future.slice(0, future.length / 2))
    const damaged = readSavedWorkspace(broken, 1000)
    expect(damaged.reason).toBe("broken")
    expect(damaged.copyKey).toBe("ade.workspace.unreadable.1000")

    const newer = new FakeStore()
    newer.setItem(WORKSPACE_KEY, future)
    const saved = readSavedWorkspace(newer, 1000)
    expect(saved.reason).toBe("newer")
    expect(saved.copyKey).toBe("ade.workspace.unreadable.1000")
  })

  test("the same damaged text found again names the copy a previous start made", () => {
    const store = new FakeStore()
    store.setItem(WORKSPACE_KEY, "{broken")
    readSavedWorkspace(store, 1000)
    expect(readSavedWorkspace(store, 9000).copyKey).toBe("ade.workspace.unreadable.1000")
  })

  test("no copy made, no name given", () => {
    const store = new FakeStore()
    store.full = true
    store.setItem = () => {
      throw new Error("QuotaExceededError")
    }
    store.data.set(WORKSPACE_KEY, "{broken")
    const saved = readSavedWorkspace(store, 1)
    expect(saved.saveBlocked).toBe(true)
    expect(saved.copyKey).toBeUndefined()
  })

  test("the notice for damage does not tell the user to update, in either language; the one for a newer version does", async () => {
    const { it } = await import("../i18n/it")
    const { en } = await import("../i18n/en")
    for (const dict of [it, en] as Array<Record<string, unknown>>) {
      const broken = (dict["workspace.unreadableBroken"] as (copy: string) => string)("ade.workspace.unreadable.7")
      expect(broken).toContain("ade.workspace.unreadable.7")
      expect(broken.toLowerCase()).not.toMatch(/aggiorna ade per|update ade to get/)
      expect(String(dict["workspace.unreadable"]).toLowerCase()).toMatch(/aggiorna ade|update ade/)
    }
  })

  test("lint: the boot picks the notice by the reason", () => {
    const source = readFileSync(join(import.meta.dir, "../surface/workbench.tsx"), "utf-8").replace(/\r\n/g, "\n")
    expect(source).toContain('savedWorkspace.reason === "broken" && savedWorkspace.copyKey')
    expect(source).toContain('t("workspace.unreadableBroken", savedWorkspace.copyKey)')
  })
})
