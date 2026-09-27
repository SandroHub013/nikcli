import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { closeAfterSaving } from "./close-window"

describe("closing the window with the X (review area 2, MEDIO)", () => {
  test("the workbench is written, and has settled, before the window goes", async () => {
    const steps: string[] = []
    await closeAfterSaving({
      flush: () => steps.push("flush"),
      settle: async () => {
        await Promise.resolve()
        steps.push("settle")
      },
      close: async () => {
        steps.push("close")
      },
    })
    expect(steps).toEqual(["flush", "settle", "close"])
  })

  test("lint: the close handler never confirms without saving first", () => {
    // The handler lives inside the workbench's onMount and cannot be called
    // from a test; what matters is that its only way to close is the one above.
    const source = readFileSync(join(import.meta.dir, "workbench.tsx"), "utf8")
    const handler = source.slice(source.indexOf('"ade-window-close-requested"'))
    const confirms = handler.slice(0, handler.indexOf("unlistenClose = unlisten"))
    expect(confirms.match(/invoke\("ade_confirm_close"/g)?.length).toBe(1)
    expect(confirms).toContain("closeAfterSaving({")
    expect(confirms).toContain("flush: () => autosave.flush()")
  })
})
