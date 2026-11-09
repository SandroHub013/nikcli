import { afterEach, describe, expect, test } from "bun:test"
import { resetLocaleForTests } from "../i18n"
import { workbenchSource } from "../test-support/workbench-source"
import { trayLabels } from "./tray-labels"

describe("the tray speaks the app's language (UX2-5)", () => {
  afterEach(() => resetLocaleForTests("it"))

  test("in English", () => {
    resetLocaleForTests("en")
    expect(trayLabels()).toEqual({ open: "Open", quit: "Exit", hidden: "chat connection on" })
  })

  test("in Italian", () => {
    resetLocaleForTests("it")
    expect(trayLabels()).toEqual({ open: "Apri", quit: "Esci", hidden: "collegamento chat acceso" })
  })

  test("the workbench tells the host, and again when the language changes", () => {
    const source = workbenchSource()
    expect(source).toContain("const labels = trayLabels()")
    expect(source).toContain("h?.setTrayLabels?.(labels)")
  })
})
