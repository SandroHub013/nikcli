import { describe, expect, test } from "bun:test"
import { registerNikcliTheme } from "./theme"

/**
 * The theme has to be registered before anything renders with it.
 *
 * It used to sit at module scope in the markdown context, which was imported
 * eagerly, so the registration always happened to have run by the time a diff
 * drew. Making the highlighter lazy removed that accident and the diff and code
 * views started throwing "No valid loader for Nikcli". Now three lazily loaded
 * entry points each register it, so what matters is that doing so repeatedly is
 * harmless and that the highlighter can actually resolve the result.
 */
describe("registerNikcliTheme", () => {
  test("registering repeatedly is harmless", () => {
    expect(() => {
      registerNikcliTheme()
      registerNikcliTheme()
      registerNikcliTheme()
    }).not.toThrow()
  })

  test("the highlighter resolves the theme rather than failing to load it", async () => {
    registerNikcliTheme()
    const { getSharedHighlighter } = await import("@pierre/diffs")
    // This is the call that threw "No valid loader for Nikcli".
    const highlighter = await getSharedHighlighter({ themes: ["Nikcli"], langs: [] })
    await highlighter.loadLanguage("typescript")
    const html = highlighter.codeToHtml("const a = 1", { lang: "typescript", theme: "Nikcli" })
    expect(html).toContain("const")
    // The theme paints with CSS variables so one registration covers both
    // schemes; a resolved-to-hex theme would mean the tokens were dropped.
    expect(html).toContain("var(--syntax")
  })

  test("a theme nobody registered still fails, so the test above proves something", async () => {
    const { getSharedHighlighter } = await import("@pierre/diffs")
    await expect(getSharedHighlighter({ themes: ["NoSuchTheme"], langs: [] })).rejects.toThrow()
  })
})
