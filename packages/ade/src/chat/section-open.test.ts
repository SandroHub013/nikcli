import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { sectionShown, useFolder } from "./first-use"
import { appChatStore, createChatStore } from "./store"

/*
 * C9: the Chat is back in the app, and showing it calls nothing. No trust
 * question, no server, no stream and no catalog before a use: a picker
 * opened, a message sent. Spies on `fetch` and on the connection prove it.
 */

const A = "C:/progetto-a"

let fetches: string[] = []
const realFetch = globalThis.fetch
beforeEach(() => {
  fetches = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetches.push(String(input))
    throw new Error("nessuna rete nei test")
  }) as unknown as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
})

function spiedStore() {
  const connects: string[] = []
  const store = createChatStore({
    connect: async (directory) => {
      connects.push(directory)
      throw new Error("server finto spento")
    },
    sleep: async () => {},
    random: () => 0,
  })
  return { store, connects }
}

describe("C9: showing the Chat calls nothing", () => {
  test("the section shown, with a project and without: no connection, no fetch, no catalog", async () => {
    const { store, connects } = spiedStore()
    const catalogs: unknown[] = []
    for (const root of [A, undefined, A]) await sectionShown(store, root, (catalog) => catalogs.push(catalog))
    expect(connects).toEqual([])
    expect(fetches).toEqual([])
    expect(catalogs).toEqual([])
    expect(store.state.status).toBe("idle")
  })

  test("the window's own store too: made, shown, and nothing leaves", async () => {
    const store = appChatStore()
    await sectionShown(store, A, () => {})
    expect(fetches).toEqual([])
    expect(store.state.status).toBe("idle")
  })

  test("the first use is what connects: once, for the folder", async () => {
    const { store, connects } = spiedStore()
    await sectionShown(store, A, () => {})
    expect(connects).toEqual([])
    await useFolder(store, A, () => {})
    expect(connects).toEqual([A])
  })

  test("lint: on mount the view calls only sectionShown, never use() or another store method", () => {
    const view = readFileSync(new URL("./chat.tsx", import.meta.url), "utf8")
    const mount = view.slice(view.indexOf("onMount(() => {"), view.indexOf("})", view.indexOf("onMount(() => {")))
    expect(mount).toMatch(/sectionShown\(store, props\.projectRoot, applyCatalog\)/)
    expect(mount).not.toMatch(/\buse\(\)|store\.(?!state)\w+\(/)
  })
})
