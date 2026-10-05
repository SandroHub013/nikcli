import { describe, expect, test } from "bun:test"
import { modAnswerFrom, modColor, modInvalidates, modSafeHref, type ModNode } from "@nikcli-ai/ui/mod-tree-model"

describe("modAnswerFrom", () => {
  test("a default answer is no drawing", () => {
    expect(modAnswerFrom({ kind: "default" })).toBeUndefined()
    expect(modAnswerFrom(undefined)).toBeUndefined()
  })

  test("a tree answer is parsed, and one without a tree draws nothing", () => {
    const tree: ModNode = { type: "Text", props: { bold: true }, children: ["hi"] }
    expect(modAnswerFrom({ kind: "tree", tree: JSON.stringify(tree) })).toEqual({ tree })
    expect(modAnswerFrom({ kind: "tree" })).toEqual({ tree: null })
  })

  test("a tree that does not parse is no drawing", () => {
    expect(modAnswerFrom({ kind: "tree", tree: "{nope" })).toBeUndefined()
  })
})

describe("modInvalidates", () => {
  const site = { component: "Pane", requestId: "pane-1" }

  test("an untargeted invalidation reaches every site, a targeted one only its own", () => {
    expect(modInvalidates({ type: "mod.ui.invalidate", properties: {} }, site)).toBe(true)
    expect(
      modInvalidates({ type: "mod.ui.invalidate", properties: { component: "Pane", requestID: "pane-1" } }, site),
    ).toBe(true)
    expect(modInvalidates({ type: "mod.ui.invalidate", properties: { component: "AbovePrompt" } }, site)).toBe(false)
    expect(modInvalidates({ type: "mod.ui.invalidate", properties: { requestID: "pane-2" } }, site)).toBe(false)
  })

  test("other events never invalidate", () => {
    expect(modInvalidates({ type: "mod.ui.panes" }, site)).toBe(false)
    expect(modInvalidates({ type: "loop.updated" }, site)).toBe(false)
  })
})

describe("modSafeHref", () => {
  test("opens web and mail links only", () => {
    expect(modSafeHref("https://nikcli.dev/docs")).toBe("https://nikcli.dev/docs")
    expect(modSafeHref("mailto:a@b.dev")).toBe("mailto:a@b.dev")
    expect(modSafeHref("javascript:alert(1)")).toBeUndefined()
    expect(modSafeHref("file:///etc/passwd")).toBeUndefined()
    expect(modSafeHref("not a url")).toBeUndefined()
  })
})

describe("modColor", () => {
  test("maps the terminal's semantic names to the window's own tokens, with the ui kit's as fallback", () => {
    expect(modColor("red")).toBe("var(--mod-critical, var(--text-critical-base))")
    expect(modColor("success")).toBe("var(--mod-success, var(--text-success-base))")
    expect(modColor("dim")).toBe("var(--mod-text-weak, var(--text-weak))")
    expect(modColor("grey")).toBe(modColor("muted"))
  })

  test("passes hex through and drops anything else, so a mod cannot inject CSS", () => {
    expect(modColor("#ff8800")).toBe("#ff8800")
    expect(modColor("red; background:url(x)")).toBeUndefined()
    expect(modColor("chartreuse")).toBeUndefined()
    expect(modColor(undefined)).toBeUndefined()
  })
})
