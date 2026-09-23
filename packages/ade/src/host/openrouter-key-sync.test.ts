import { describe, expect, test } from "bun:test"
import { syncOpenRouterKey, type KeySyncDeps } from "./openrouter-key-sync"

/* Fake values only: no real auth.json or key is read by these tests. */
const FAKE_KEY = "sk-or-v1-fake-test-key-000"

function world(identifier: string | Error) {
  const reads: string[] = []
  const saved: string[] = []
  const deps: KeySyncDeps = {
    identifier: async () => {
      if (identifier instanceof Error) throw identifier
      return identifier
    },
    homeDir: async () => "C:/Users/finto",
    readTextFile: async (path) => {
      reads.push(path)
      return path === "C:/Users/finto/AppData/Local/nikcli/auth.json" ? { text: JSON.stringify({ openrouter: { key: FAKE_KEY } }) } : undefined
    },
    save: async (key) => void saved.push(key),
  }
  return { deps, reads, saved }
}

describe("the voice's OpenRouter key from nikcli's auth.json", () => {
  test("ADE Test's identity: not copied, and auth.json is not even read", async () => {
    const { deps, reads, saved } = world("ai.nikcli.ade.test")
    expect(await syncOpenRouterKey(deps)).toBe("test-identity")
    expect(reads).toEqual([])
    expect(saved).toEqual([])
  })

  test("the user's ADE: copied, as before", async () => {
    const { deps, saved } = world("ai.nikcli.ade")
    expect(await syncOpenRouterKey(deps)).toBe("copied")
    expect(saved).toEqual([FAKE_KEY])
  })

  test("an identity that cannot be asked is treated as the test one", async () => {
    const { deps, reads, saved } = world(new Error("no Tauri"))
    expect(await syncOpenRouterKey(deps)).toBe("test-identity")
    expect(reads).toEqual([])
    expect(saved).toEqual([])
  })

  test("no auth.json with a key: nothing saved", async () => {
    const { deps, saved } = world("ai.nikcli.ade")
    deps.readTextFile = async () => undefined
    expect(await syncOpenRouterKey(deps)).toBe("not-found")
    expect(saved).toEqual([])
  })
})
