import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { forgetLegacyConversation, LEGACY_CONVERSATION_KEY } from "./legacy"

/* C7 (BASSO of C8): the direct path's old conversation does not stay on disk. */

function memoryStorage(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries))
  return {
    map,
    removeItem: (key: string) => void map.delete(key),
  }
}

describe("the direct path's old conversation", () => {
  test("is removed; the pickers' choices stay", () => {
    const storage = memoryStorage({
      [LEGACY_CONVERSATION_KEY]: JSON.stringify({ messages: [{ id: "m1", role: "user", text: "ciao", at: 1 }] }),
      "ade.chat.model": '{"providerID":"openrouter","modelID":"a/b:free"}',
      "ade.chat.agent": "build",
    })
    forgetLegacyConversation(storage)
    expect([...storage.map.keys()].sort()).toEqual(["ade.chat.agent", "ade.chat.model"])
    // Again: nothing left to do, nothing else touched.
    forgetLegacyConversation(storage)
    expect(storage.map.size).toBe(2)
  })

  test("storage that refuses, or is not there, is left alone", () => {
    expect(() =>
      forgetLegacyConversation({
        removeItem: () => {
          throw new DOMException("denied", "SecurityError")
        },
      }),
    ).not.toThrow()
    expect(() => forgetLegacyConversation(undefined)).not.toThrow()
  })

  test("lint: the Chat calls forgetLegacyConversation when it starts", () => {
    const view = readFileSync(new URL("./chat.tsx", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
    expect(view).toMatch(/forgetLegacyConversation\(\)/)
  })
})
