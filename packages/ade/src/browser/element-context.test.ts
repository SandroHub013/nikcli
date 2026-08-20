import { describe, expect, test } from "bun:test"
import { describeElement, formatSelectionContext } from "./element-context"
import type { InspectedElement } from "./protocol"

const MOCK_BUTTON: InspectedElement = {
  selector: "button#submit-btn.btn.btn-primary.btn-lg",
  tagName: "button",
  id: "submit-btn",
  className: "btn btn-primary btn-lg extra-class",
  innerText: "Save Changes",
  outerHTML: '<button id="submit-btn" class="btn btn-primary btn-lg">Save Changes</button>',
  detectedLanguage: "tsx",
  rect: { top: 100, left: 50, width: 140, height: 42 },
  styles: {
    display: "inline-flex",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
    padding: "10px 16px",
    margin: "0px",
    color: "rgb(255, 255, 255)",
    backgroundColor: "rgb(59, 130, 246)",
    fontSize: "14px",
    fontWeight: "600",
    lineHeight: "20px",
    textAlign: "center",
    borderRadius: "6px",
    borderWidth: "1px",
    borderColor: "transparent",
    opacity: "1",
    boxShadow: "none",
    width: "140px",
    height: "42px",
  },
}

describe("describeElement", () => {
  test("formats fully-populated element with index", () => {
    const output = describeElement(MOCK_BUTTON, 0)
    expect(output).toContain("1. <button#submit-btn.btn.btn-primary.btn-lg> (tsx)")
    expect(output).toContain("   selector: button#submit-btn.btn.btn-primary.btn-lg")
    expect(output).toContain("   box: 140×42 · display: inline-flex · padding: 10px 16px · margin: 0px")
    expect(output).toContain(
      "   text: rgb(255, 255, 255) 14px/600 · background: rgb(59, 130, 246) · radius: 6px",
    )
    expect(output).toContain('   content: "Save Changes"')
  })

  test("handles missing fields gracefully without throwing", () => {
    const minimal: Partial<InspectedElement> = {
      tagName: "div",
      className: "card",
      selector: "div.card",
    }
    const output = describeElement(minimal)
    expect(output).toContain("<div.card> (html)")
    expect(output).toContain("   selector: div.card")
    expect(output).toContain("   box: 0×0 · display: block")
    expect(output).not.toContain("content:")
  })

  test("handles empty or null element gracefully", () => {
    expect(describeElement(null)).toBe("<unknown>")
    expect(describeElement(undefined, 2)).toBe("3. <unknown>")
    expect(describeElement({})).toContain("<element> (html)")
  })

  test("filters out internal __nikcli classes", () => {
    const withInternalClass: Partial<InspectedElement> = {
      tagName: "div",
      className: "__nikcli_hover_outline custom-box",
    }
    const output = describeElement(withInternalClass)
    expect(output).toContain("<div.custom-box>")
    expect(output).not.toContain("__nikcli")
  })

  test("sanitizes multiline innerText and truncates long text", () => {
    const longText = "Line 1\nLine 2\twith tabs and very long content ".repeat(10)
    const withText: Partial<InspectedElement> = {
      tagName: "p",
      innerText: longText,
    }
    const output = describeElement(withText)
    expect(output).toContain('   content: "')
    expect(output).not.toContain("\nLine 2")
    expect(output).toContain("...")
  })
})

describe("formatSelectionContext", () => {
  test("formats empty selection as empty string", () => {
    expect(formatSelectionContext([])).toBe("")
  })

  test("formats single element with URL", () => {
    const context = formatSelectionContext([MOCK_BUTTON], { url: "http://localhost:3000" })
    expect(context).toContain("[Design Mode · 1 element on http://localhost:3000]")
    expect(context).toContain("1. <button#submit-btn.btn.btn-primary.btn-lg>")
  })

  test("formats multiple elements with instruction", () => {
    const card: Partial<InspectedElement> = {
      tagName: "section",
      id: "hero",
      selector: "section#hero",
      detectedLanguage: "tsx",
    }
    const context = formatSelectionContext([MOCK_BUTTON, card], {
      url: "http://localhost:5173",
      instruction: "Align these two elements horizontally with 16px gap.",
    })

    expect(context).toContain("[Design Mode · 2 elements on http://localhost:5173]")
    expect(context).toContain("1. <button#submit-btn")
    expect(context).toContain("2. <section#hero> (tsx)")
    expect(context).toContain("Align these two elements horizontally with 16px gap.")
  })
})
