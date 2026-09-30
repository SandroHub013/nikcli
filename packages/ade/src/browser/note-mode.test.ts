import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { INSPECTOR_BRIDGE_SCRIPT } from "./protocol"

/*
 * The inspector bridge's `note` mode (design sheet, piece 2), run in happy-dom
 * the way the frame script runs it, as in `sections.test.ts`: Inspect on a
 * sheet, where a click picks an element, a drag picks text, and nothing is
 * dragged around.
 */
const posted: any[] = []
const listeners: ((event: { data: unknown }) => void)[] = []
const tell = (data: unknown) => listeners.forEach((listener) => listener({ data }))
const userInput = new WeakSet<Event>()
const sent = (type: string) => posted.filter((message) => message.type === type)

beforeAll(() => {
  const shim = {
    __NIKCLI_INSPECTOR_ACTIVE__: false,
    __ADE_LISTEN__: (target: EventTarget, type: string, handler: (event: Event) => void, options?: boolean) =>
      target.addEventListener(type, (event) => userInput.has(event) && handler(event), options),
    parent: { postMessage: (message: unknown) => posted.push(message) },
    getComputedStyle: (element: Element) => window.getComputedStyle(element),
    addEventListener: (type: string, handler: any) => {
      if (type === "message") listeners.push(handler)
    },
  }
  const quiet = { ...console }
  new Function("window", INSPECTOR_BRIDGE_SCRIPT)(shim)
  Object.assign(console, quiet)
})

beforeEach(() => {
  posted.length = 0
  tell({ type: "visual-editor:clear-selection" })
  document.getSelection()?.removeAllRanges()
  document.body.innerHTML = `<main><p id="intro">Prenota ora il tuo tavolo</p><button id="buy">Compra</button></main>`
})

/** Selects `length` characters of `#intro` from `start`, as a drag would. */
function selectText(start: number, length: number) {
  const text = document.querySelector("#intro")!.firstChild!
  const range = document.createRange()
  range.setStart(text, start)
  range.setEnd(text, start + length)
  const selection = document.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

function mouse(type: string, target: Element, real = true) {
  const original = document.elementFromPoint
  document.elementFromPoint = () => target
  try {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true })
    if (real) userInput.add(event)
    target.dispatchEvent(event)
  } finally {
    document.elementFromPoint = original
  }
}

describe("note mode", () => {
  test("a text selected with the mouse is reported, with the element it sits in", () => {
    tell({ type: "visual-editor:set-mode", mode: "note" })
    selectText(0, 11)
    mouse("mouseup", document.querySelector("#intro")!)
    const [picked] = sent("visual-editor:text-selected")
    expect(picked?.text).toBe("Prenota ora")
    expect(picked?.element?.selector).toBe("#intro")
  })

  test("a selection the page makes up, with no real mouse, is not", () => {
    tell({ type: "visual-editor:set-mode", mode: "note" })
    selectText(0, 11)
    mouse("mouseup", document.querySelector("#intro")!, false)
    expect(sent("visual-editor:text-selected")).toEqual([])
  })

  test("outside note mode no text is reported", () => {
    for (const mode of ["browse", "edit"]) {
      tell({ type: "visual-editor:set-mode", mode })
      selectText(0, 11)
      mouse("mouseup", document.querySelector("#intro")!)
    }
    expect(sent("visual-editor:text-selected")).toEqual([])
  })

  test("a click still picks an element, and nothing is made draggable", () => {
    tell({ type: "visual-editor:set-mode", mode: "note" })
    const buy = document.querySelector("#buy")!
    mouse("mousedown", buy)
    expect(buy.hasAttribute("draggable")).toBe(false)
    mouse("click", buy)
    expect(sent("visual-editor:element-selected").map((message) => message.element.selector)).toEqual(["#buy"])
  })

  test("the click that ends a text selection picks the text, not the element", () => {
    tell({ type: "visual-editor:set-mode", mode: "note" })
    selectText(0, 11)
    mouse("click", document.querySelector("#intro")!)
    expect(sent("visual-editor:element-selected")).toEqual([])
  })

  test("edit mode keeps its drag", () => {
    tell({ type: "visual-editor:set-mode", mode: "edit" })
    const buy = document.querySelector("#buy")!
    mouse("mousedown", buy)
    expect(buy.getAttribute("draggable")).toBe("true")
    mouse("mouseup", buy)
    tell({ type: "visual-editor:set-mode", mode: "browse" })
  })
})
