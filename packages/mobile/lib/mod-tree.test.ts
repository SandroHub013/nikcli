/// <reference types="@types/bun" />

import { describe, expect, test } from "bun:test"
import { answerFrom, invalidates, isModEvent, modColor, plainText, safeHref, type ModNode } from "./mod-tree"

const palette = {
  ink: "#111",
  muted: "#888",
  accent: "#0af",
  success: "#0a0",
  warn: "#fa0",
  danger: "#f00",
  info: "#00f",
}

describe("answerFrom", () => {
  test("a default answer is no drawing", () => {
    expect(answerFrom({ kind: "default" })).toBeUndefined()
    expect(answerFrom(undefined)).toBeUndefined()
  })

  test("a tree answer is parsed", () => {
    const tree: ModNode = { type: "Text", props: { bold: true }, children: ["hi"] }
    expect(answerFrom({ kind: "tree", tree: JSON.stringify(tree) })).toEqual({ tree })
  })

  test("a tree answer without a tree draws nothing", () => {
    expect(answerFrom({ kind: "tree" })).toEqual({ tree: null })
  })

  test("a tree that does not parse is no drawing", () => {
    expect(answerFrom({ kind: "tree", tree: "{nope" })).toBeUndefined()
  })
})

describe("invalidates", () => {
  const site = { component: "Pane", requestId: "pane-1" }

  test("an untargeted invalidation reaches every site", () => {
    expect(invalidates({ type: "mod.ui.invalidate", properties: {} }, site)).toBe(true)
  })

  test("a targeted one reaches only its site", () => {
    expect(
      invalidates({ type: "mod.ui.invalidate", properties: { component: "Pane", requestID: "pane-1" } }, site),
    ).toBe(true)
    expect(invalidates({ type: "mod.ui.invalidate", properties: { component: "AbovePrompt" } }, site)).toBe(false)
    expect(invalidates({ type: "mod.ui.invalidate", properties: { requestID: "pane-2" } }, site)).toBe(false)
  })

  test("other events never invalidate", () => {
    expect(invalidates({ type: "mod.ui.panes" }, site)).toBe(false)
    expect(invalidates({ type: "loop.updated" }, site)).toBe(false)
  })
})

describe("isModEvent", () => {
  test("recognises the two mod ui events", () => {
    expect(isModEvent({ type: "mod.ui.panes" })).toBe(true)
    expect(isModEvent({ type: "mod.ui.invalidate" })).toBe(true)
    expect(isModEvent({ type: "mod.log" })).toBe(false)
  })
})

describe("safeHref", () => {
  test("opens web and mail links only", () => {
    expect(safeHref("https://nikcli.dev/docs")).toBe("https://nikcli.dev/docs")
    expect(safeHref("mailto:a@b.dev")).toBe("mailto:a@b.dev")
    expect(safeHref("javascript:alert(1)")).toBeUndefined()
    expect(safeHref("file:///etc/passwd")).toBeUndefined()
    expect(safeHref("not a url")).toBeUndefined()
  })
})

describe("modColor", () => {
  test("maps the terminal's semantic names", () => {
    expect(modColor("red", palette)).toBe("#f00")
    expect(modColor("success", palette)).toBe("#0a0")
    expect(modColor("dim", palette)).toBe("#888")
    expect(modColor("primary", palette)).toBe("#0af")
  })

  test("passes hex through and drops unknown words", () => {
    expect(modColor("#ff8800", palette)).toBe("#ff8800")
    expect(modColor("chartreuse", palette)).toBeUndefined()
    expect(modColor(undefined, palette)).toBeUndefined()
  })
})

describe("plainText", () => {
  test("flattens a tree for a screen reader", () => {
    const tree: ModNode = {
      type: "Box",
      props: {},
      children: [
        { type: "Text", props: {}, children: ["Build ", { type: "Text", props: { bold: true }, children: ["ok"] }] },
        { type: "Button", key: "retry", props: { label: "Retry" } },
        false,
        null,
      ],
    }
    expect(plainText(tree)).toBe("Build ok Retry")
  })
})
