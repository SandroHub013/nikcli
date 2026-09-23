import { describe, expect, test } from "bun:test"
import { nextFocusIndex, updateDialogView } from "./dialog-state"

describe("update dialog", () => {
  test("the question offers later and go, and can be dismissed", () => {
    const view = updateDialogView({ updating: false, progress: undefined, error: undefined })
    expect(view.stage).toBe("ask")
    expect(view.ghost).toEqual({ label: "later", enabled: true })
    expect(view.submit).toEqual({ label: "go", enabled: true })
    expect(view.dismissable).toBe(true)
  })

  test("while the download runs it cannot be stopped, but the dialog can be put away", () => {
    const view = updateDialogView({ updating: true, progress: { phase: "download", downloaded: 1, total: 9 }, error: undefined })
    expect(view.stage).toBe("download")
    expect(view.ghost).toEqual({ label: "hide", enabled: true })
    expect(view.submit.enabled).toBe(false)
    expect(view.dismissable).toBe(true)
  })

  test("the hand-over to the installer keeps the same way out", () => {
    const view = updateDialogView({ updating: true, progress: { phase: "install" }, error: undefined })
    expect(view.ghost).toEqual({ label: "hide", enabled: true })
    expect(view.submit.enabled).toBe(false)
  })

  test("updating with no news yet is still the download", () => {
    expect(updateDialogView({ updating: true, progress: undefined, error: undefined }).stage).toBe("download")
  })

  test("the hand-over to the installer is its own stage", () => {
    expect(updateDialogView({ updating: true, progress: { phase: "install" }, error: undefined }).stage).toBe("install")
  })

  test("a failure offers close and retry, whatever else was going on", () => {
    const view = updateDialogView({ updating: false, progress: { phase: "download", downloaded: 3, total: 9 }, error: "connection reset" })
    expect(view.stage).toBe("error")
    expect(view.ghost).toEqual({ label: "close", enabled: true })
    expect(view.submit).toEqual({ label: "retry", enabled: true })
    expect(view.dismissable).toBe(true)
  })

  test("Tab wraps inside the dialog in both directions", () => {
    expect(nextFocusIndex(-1, 3, false)).toBe(0)
    expect(nextFocusIndex(-1, 3, true)).toBe(2)
    expect(nextFocusIndex(0, 3, false)).toBe(1)
    expect(nextFocusIndex(2, 3, false)).toBe(0)
    expect(nextFocusIndex(0, 3, true)).toBe(2)
    expect(nextFocusIndex(1, 3, true)).toBe(0)
    expect(nextFocusIndex(0, 0, false)).toBe(-1)
  })
})
