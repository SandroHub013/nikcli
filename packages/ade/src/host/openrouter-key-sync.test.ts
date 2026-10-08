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
      return path === "C:/Users/finto/AppData/Local/nikcli/auth.json"
        ? { text: JSON.stringify({ openrouter: { key: FAKE_KEY } }) }
        : undefined
    },
    save: async (key) => void saved.push(key),
    removed: () => false,
  }
  return { deps, reads, saved }
}

describe("where ragu keeps its key on macOS and Linux", () => {
  test("`~/.local/share/nikcli/auth.json` is looked at", async () => {
    const seen: string[] = []
    const outcome = await syncOpenRouterKey({
      identifier: async () => "ai.nikcli.ade",
      homeDir: async () => "/Users/chi",
      readTextFile: async (path) => {
        seen.push(path)
        return path === "/Users/chi/.local/share/nikcli/auth.json"
          ? { text: JSON.stringify({ openrouter: { key: "sk-or-x" } }) }
          : undefined
      },
      save: async () => {},
      removed: () => false,
    })
    expect(outcome).toBe("copied")
    expect(seen).toContain("/Users/chi/.local/share/nikcli/auth.json")
  })
})

describe("the voice's OpenRouter key from ragu's auth.json", () => {
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

  test("a key removed by the user is not read from auth.json again", async () => {
    const { deps, reads, saved } = world("ai.nikcli.ade")
    deps.removed = () => true
    expect(await syncOpenRouterKey(deps)).toBe("removed")
    expect(reads).toEqual([])
    expect(saved).toEqual([])
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
