import { describe, expect, test } from "bun:test"
import { FRAME_PLUGINS_KEY, anyFramePlugin, markFramePlugins } from "./marker"

function memory() {
  const data: Record<string, string> = {}
  return {
    data,
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => void (data[key] = value),
    removeItem: (key: string) => void delete data[key],
  }
}

describe("whether any plugin was seen installed", () => {
  test("nothing is marked until a plugin is seen, and it goes away with the last one", () => {
    const store = memory()
    expect(anyFramePlugin(store)).toBe(false)
    markFramePlugins(true, store)
    expect(anyFramePlugin(store)).toBe(true)
    expect(store.data[FRAME_PLUGINS_KEY]).toBe("1")
    markFramePlugins(false, store)
    expect(anyFramePlugin(store)).toBe(false)
  })

  test("a storage that throws is a profile with no plugin, and never an error", () => {
    const broken = {
      getItem() {
        throw new Error("blocked")
      },
      setItem() {
        throw new Error("full")
      },
      removeItem() {
        throw new Error("full")
      },
    }
    expect(anyFramePlugin(broken)).toBe(false)
    expect(() => markFramePlugins(true, broken)).not.toThrow()
    expect(anyFramePlugin(undefined)).toBe(false)
  })
})
