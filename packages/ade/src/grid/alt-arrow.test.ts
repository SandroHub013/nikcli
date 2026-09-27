import { afterEach, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { compileSolidJsx } from "../test-support/solid-jsx"

/*
 * Alt+Arrow moves the focus to the neighbouring pane. It was left to bubble,
 * and xterm stops a keydown on its textarea before it bubbles: from a terminal
 * the focus did not move and the shell got `ESC[1;3D` (review area 2). The
 * pane below does what xterm does with the event.
 */

if (typeof document === "undefined") GlobalRegistrator.register()
compileSolidJsx()

const { createComponent, render } = await import("solid-js/web")
const { SessionGrid } = await import("./session-grid")

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
})

test("Alt+Arrow from inside a terminal moves the focus, and the terminal does not get it", () => {
  const reachedTerminal: string[] = []
  const focused: string[] = []
  const terminal = (id: string) => {
    const box = document.createElement("textarea")
    box.dataset.terminal = id
    // xterm: it handles the key on its textarea and stops it there.
    box.addEventListener("keydown", (event) => {
      reachedTerminal.push(id)
      event.stopPropagation()
    })
    return box
  }
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () =>
      createComponent(SessionGrid, {
        panes: [
          { id: "a", render: () => terminal("a") },
          { id: "b", render: () => terminal("b") },
        ],
        focused: "a",
        // No size in happy-dom: one column, so b is below a.
        onFocus: (id: string) => focused.push(id),
      }),
    host,
  )
  const inA = host.querySelector<HTMLElement>('[data-terminal="a"]')!
  inA.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true, cancelable: true }))
  expect(focused).toEqual(["b"])
  expect(reachedTerminal).toEqual([])
})
