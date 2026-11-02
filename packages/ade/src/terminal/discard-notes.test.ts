import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { createDiscardNotes } from "./discard-notes"

const WORKBENCH = readFileSync(join(import.meta.dir, "../surface/workbench.tsx"), "utf8")

/*
 * Review of ade/flood-pagina, point 6. The notice that xterm threw output away was said once per pane for the life of
 * the page, so the second time output was lost, in a later run or a later minimise, nothing was said at all.
 */
describe("the notice that output was discarded", () => {
  const notes = () => {
    const said: string[] = []
    const events = new EventTarget()
    let visibility = "hidden"
    const doc = {
      get visibilityState() {
        return visibility
      },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    }
    const back = () => {
      visibility = "visible"
      events.dispatchEvent(new Event("visibilitychange"))
    }
    const hide = () => {
      visibility = "hidden"
      events.dispatchEvent(new Event("visibilitychange"))
    }
    return { said, back, hide, discard: createDiscardNotes((pane) => said.push(pane), doc) }
  }

  test("once for a pane's whole burst, not for every chunk", () => {
    const { said, discard } = notes()
    discard.refused("a")
    discard.refused("a")
    discard.refused("b")
    expect(said).toEqual(["a", "b"])
  })

  test("said again for the next program in the pane", () => {
    const { said, discard } = notes()
    discard.refused("a")
    discard.started("a")
    discard.refused("a")
    expect(said).toEqual(["a", "a"])
  })

  test("said again once the window has come back", () => {
    const { said, discard, back, hide } = notes()
    discard.refused("a")
    hide()
    discard.refused("a")
    expect(said).toEqual(["a"])
    back()
    discard.refused("a")
    expect(said).toEqual(["a", "a"])
  })

  test("once disposed it stops watching the window", () => {
    const { said, discard, back } = notes()
    discard.refused("a")
    discard.dispose()
    back()
    discard.refused("a")
    expect(said).toEqual(["a"])
  })

  test("lint: the workbench says a refusal, and each start of a pane forgets the one before", () => {
    expect(WORKBENCH).toContain("if (!writeToTerminal(paneId, chunk, written)) discardNotes.refused(paneId)")
    const starts = WORKBENCH.split("startOnCleanScreen(paneId)").slice(1)
    expect(starts.length).toBe(2)
    for (const after of starts) expect(after.trimStart().startsWith("discardNotes.started(paneId)")).toBe(true)
  })
})
