import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { emptyChatData } from "./events"
import { isOpenOn, useFolder, type FirstUseStore } from "./first-use"
import type { ChatState, ChatStatus } from "./store"

/* C4, for C9: nothing is called because the Chat section opened. */

const A = "C:/progetto-a"

function fakeStore(after: ChatStatus = "connecting") {
  const calls: string[] = []
  const state: ChatState = { status: "idle", data: emptyChatData() }
  const store: FirstUseStore = {
    state,
    async open(directory) {
      calls.push(`open ${directory}`)
      Object.assign(state, { directory, status: after })
    },
    async catalog() {
      calls.push("catalog")
      return { configModel: "openrouter/x:free" }
    },
  }
  return { store, state, calls }
}

describe("the chat's first use of a folder", () => {
  test("opens the folder and reads its catalog; again, it opens nothing new", async () => {
    const { store, calls } = fakeStore()
    const seen: (string | undefined)[] = []
    expect(await useFolder(store, A, (catalog) => seen.push(catalog.configModel))).toBe(true)
    expect(await useFolder(store, A, (catalog) => seen.push(catalog.configModel))).toBe(true)
    // The store keeps the catalog per opening; here the second call is the store's to answer.
    expect(calls).toEqual([`open ${A}`, "catalog", "catalog"])
    expect(seen).toEqual(["openrouter/x:free", "openrouter/x:free"])
  })

  test("no project, or a folder refused: no catalog", async () => {
    const none = fakeStore()
    expect(await useFolder(none.store, undefined, () => {})).toBe(false)
    expect(none.calls).toEqual([])
    const refused = fakeStore("refused")
    expect(await useFolder(refused.store, A, () => {})).toBe(false)
    expect(refused.calls).toEqual([`open ${A}`])
  })

  test("a folder counts as open only when it is this one and not idle or refused", () => {
    const { store, state } = fakeStore()
    expect(isOpenOn(store, A)).toBe(false)
    Object.assign(state, { directory: A, status: "live" })
    expect(isOpenOn(store, A)).toBe(true)
    expect(isOpenOn(store, "C:/altro")).toBe(false)
    Object.assign(state, { status: "refused" })
    expect(isOpenOn(store, A)).toBe(false)
  })

  test("the same folder written another way is the one open: no second opening", async () => {
    const { store, state, calls } = fakeStore()
    Object.assign(state, { directory: "C:/Progetto-A", status: "live" })
    expect(isOpenOn(store, "c:\\progetto-a\\")).toBe(true)
    expect(await useFolder(store, "c:\\progetto-a\\", () => {})).toBe(true)
    expect(calls).toEqual(["catalog"])
  })

  test("the view opens a folder only through a use: no open, no catalog, no connection of its own", () => {
    const view = readFileSync(new URL("./chat.tsx", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
    expect(view).not.toMatch(/store\.open\(/)
    expect(view).not.toMatch(/store\.catalog\(/)
    expect(view).not.toMatch(/\bopenChat\(/)
    expect(view).not.toMatch(/\bloadChatCatalog\(/)
    expect(view).toMatch(/useFolder\(/)
  })
})
