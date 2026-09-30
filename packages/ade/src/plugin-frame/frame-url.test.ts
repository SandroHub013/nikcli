import { describe, expect, test } from "bun:test"
import { ENTRY, PLUGIN_SCHEME, pluginFrameUrl, pluginOrigin, validPluginId } from "./frame-url"

describe("where the frame loads from", () => {
  test("Windows has http://plugin.localhost, the other webviews plugin://localhost", () => {
    expect(pluginOrigin(true)).toBe("http://plugin.localhost")
    expect(pluginOrigin(false)).toBe("plugin://localhost")
    expect(PLUGIN_SCHEME).toBe("plugin")
  })

  test("the address is the plugin's id, its entry page, and the nonce in the fragment", () => {
    const nonce = "a".repeat(48)
    expect(pluginFrameUrl("hello", nonce, true)).toBe(`http://plugin.localhost/hello/${ENTRY}#n=${nonce}`)
    expect(pluginFrameUrl("hello", nonce, false)).toBe(`plugin://localhost/hello/${ENTRY}#n=${nonce}`)
  })

  test("the nonce is never in the query, which a server would see", () => {
    expect(pluginFrameUrl("hello", "n".repeat(48), true)).not.toContain("?")
  })

  test("an id the native side would refuse is refused here too, and cannot smuggle a path or a host into the address", () => {
    for (const id of ["", "A", "a", "1abc", "a b", "a/b", "a\b", "..", "a..", "a:b", "a@evil.example", "a#b", "a?b", "é", "x".repeat(33), "-ab"]) {
      expect([id, validPluginId(id)]).toEqual([id, false])
      expect(() => pluginFrameUrl(id, "n", true)).toThrow()
    }
    for (const id of ["nikverse", "hello", "ab", "a-b-c", `a${"b".repeat(31)}`]) expect(validPluginId(id)).toBe(true)
    expect(validPluginId(undefined)).toBe(false)
    expect(validPluginId(7)).toBe(false)
  })
})
