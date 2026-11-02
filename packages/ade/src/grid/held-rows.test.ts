import { afterEach, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { compileSolidJsx } from "../test-support/solid-jsx"
import { HELD_ROWS_MS } from "./held-rows"
import type { SessionPaneProps } from "./pane"

if (typeof document === "undefined") GlobalRegistrator.register()
compileSolidJsx()

/*
 * The rows of a transcript behind a live terminal are not on screen, and each flood's chunk built 200 of them: half of
 * what a flood allocated, 123 MB for 30 MiB, which reached the old space faster than the automatic GCs freed it. The
 * renderer passed 2 GB after 340 MB of output (live test of 2026-11-02). The real pane, with a store like the
 * workbench's.
 */

const { createComponent, render } = await import("solid-js/web")
const { createStore } = await import("solid-js/store")
const { SessionPane } = await import("./pane")

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
})

const lineOf = (text: string) => ({ kind: "step" as const, text })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function mount(start: string[], terminal: boolean) {
  const [state, setState] = createStore<{ lines: { kind: "step"; text: string }[]; terminalId?: string }>({
    lines: start.map(lineOf),
    ...(terminal ? { terminalId: "t" } : {}),
  })
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () =>
      createComponent(SessionPane, {
        title: "Sessione",
        status: "idle",
        get lines() {
          return state.lines
        },
        get terminalId() {
          return state.terminalId
        },
      } as SessionPaneProps),
    host,
  )
  const rows = () => [...host.querySelectorAll('[data-slot="pane-line"]')].map((row) => row.textContent?.trim())
  return { state, setState, rows }
}

describe("the rows of a transcript behind a live terminal", () => {
  test("thirty chunks in a row build the rows once at most, and not once per chunk", async () => {
    const pane = mount(["prima"], true)
    expect(pane.rows()).toEqual(["prima"])
    for (let chunk = 0; chunk < 30; chunk++) pane.setState("lines", [lineOf(`blocco ${chunk}`)])
    expect(pane.rows()).toEqual(["prima"])
    await sleep(HELD_ROWS_MS + 100)
    expect(pane.rows()).toEqual(["blocco 29"])
  })

  test("the last chunk of a burst is drawn in the end: nothing stays held", async () => {
    const pane = mount([], true)
    pane.setState("lines", [lineOf("uno")])
    await sleep(HELD_ROWS_MS + 100)
    pane.setState("lines", [lineOf("due")])
    await sleep(HELD_ROWS_MS + 100)
    expect(pane.rows()).toEqual(["due"])
  })

  test("with no terminal the transcript is on screen: each line is drawn at once", () => {
    const pane = mount(["prima"], false)
    pane.setState("lines", [lineOf("seconda")])
    expect(pane.rows()).toEqual(["seconda"])
  })

  test("the terminal gone, the transcript that comes into view is the whole one at once", () => {
    const pane = mount(["prima"], true)
    pane.setState("lines", [lineOf("ultima")])
    expect(pane.rows()).toEqual(["prima"])
    pane.setState("terminalId", undefined)
    expect(pane.rows()).toEqual(["ultima"])
  })

  test("the pane closed, a held draw does not run on what is gone", async () => {
    const pane = mount([], true)
    pane.setState("lines", [lineOf("uno")])
    dispose?.()
    dispose = undefined
    await sleep(HELD_ROWS_MS + 100)
    expect(pane.rows()).toEqual([])
  })
})
