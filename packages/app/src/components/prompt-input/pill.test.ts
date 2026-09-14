import { describe, expect, test } from "bun:test"
import { isPillNode, isPillType, PILL_TYPES } from "./pill"

/**
 * The caret walks the editor by node, treating a pill as one indivisible step.
 * A part type that is rendered as a chip but not recognised here would let the
 * caret land inside it, which splits the chip on the next keystroke.
 */
describe("isPillType", () => {
  test.each([...PILL_TYPES])("%p is a pill", (type) => {
    expect(isPillType(type)).toBe(true)
  })

  test.each(["text", "image", "source", "", undefined])("%p is not", (type) => {
    expect(isPillType(type)).toBe(false)
  })
})

describe("isPillNode", () => {
  const element = (type?: string) => {
    const node = document.createElement("span")
    if (type !== undefined) node.setAttribute("data-type", type)
    return node
  }

  test.each([...PILL_TYPES])("an element carrying data-type=%p is a pill", (type) => {
    expect(isPillNode(element(type))).toBe(true)
  })

  test("an element with no data-type is not", () => {
    expect(isPillNode(element())).toBe(false)
  })

  test("a text node is not, whatever it contains", () => {
    expect(isPillNode(document.createTextNode("@src/index.ts"))).toBe(false)
  })

  test("a line break is not — it is a step of its own", () => {
    expect(isPillNode(document.createElement("br"))).toBe(false)
  })
})
