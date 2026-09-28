import { describe, expect, test } from "bun:test"
import { compileSolidJsx } from "../test-support/solid-jsx"

/*
 * 0.9.1: «Aggiorna» in the bell did nothing when pressed. The footer's buttons
 * are a JSX prop, a getter that builds them again on every read, and the
 * sidebar read it twice: the bell's menu existed twice, and the copy that was
 * never inserted closed the real one on every pointerdown inside it, before
 * the click could land.
 */
compileSolidJsx()
const { createRoot } = await import("solid-js")
const { render } = await import("solid-js/web")
const { Sidebar } = await import("./sidebar")

describe("the sidebar's footer buttons", () => {
  test("are built once, and the ones built are the ones on screen", () => {
    const built: HTMLElement[] = []
    const host = document.createElement("div")
    document.body.append(host)
    const dispose = createRoot((dispose) => {
      render(
        () =>
          Sidebar({
            workspaces: [],
            storage: undefined,
            get footerActions() {
              const bell = document.createElement("button")
              bell.dataset.probe = "bell"
              built.push(bell)
              return bell
            },
          }),
        host,
      )
      return dispose
    })
    expect(built).toHaveLength(1)
    expect(built[0]!.isConnected).toBe(true)
    expect(host.querySelectorAll('[data-probe="bell"]')).toHaveLength(1)
    dispose()
    host.remove()
  })
})
