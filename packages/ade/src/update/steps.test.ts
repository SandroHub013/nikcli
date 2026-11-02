import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { updateInSteps } from "./steps"

function recording(overrides: { download?: () => Promise<unknown>; install?: () => Promise<unknown> } = {}) {
  const steps: string[] = []
  const note = (name: string) => () => {
    steps.push(name)
  }
  const run = updateInSteps({
    download: overrides.download ?? (async () => steps.push("download")),
    stopMail: note("stopMail"),
    settle: async () => steps.push("settle"),
    save: note("save"),
    waitForDisk: async () => steps.push("waitForDisk"),
    install: overrides.install ?? (async () => steps.push("install")),
  })
  return { steps, run }
}

describe("updateInSteps", () => {
  test("the mail stops as late as it can, after the download and the take, and the state is saved after it stopped", async () => {
    const { steps, run } = recording()
    await run
    expect(steps).toEqual(["download", "settle", "stopMail", "save", "waitForDisk", "install"])
  })

  test("a download that takes its time leaves the mail moving", async () => {
    let finish = () => {}
    const { steps, run } = recording({ download: () => new Promise<void>((resolve) => (finish = resolve)) })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(steps).toEqual([])
    finish()
    await run
    expect(steps).toContain("stopMail")
  })

  test("a download that fails stops nothing and installs nothing", async () => {
    const { steps, run } = recording({ download: () => Promise.reject(new Error("nessun dato")) })
    await expect(run).rejects.toThrow("nessun dato")
    expect(steps).toEqual([])
  })
})

describe("the wiring in the workbench", () => {
  const source = readFileSync(new URL("../surface/workbench.tsx", import.meta.url), "utf8")

  test("the mail round waits for the install, not for the whole update", () => {
    expect(source).toContain("paused: () => installingUpdate(),")
    expect(source).not.toContain("paused: () => updating(),")
  })

  test("an update asks for the download and the install apart, and a take is finished before the install", () => {
    const run = source.slice(source.indexOf("const runUpdate = async () => {"))
    expect(run.indexOf('invoke("ade_update_download")')).toBeGreaterThan(-1)
    const settle = run.indexOf("settle: () => {")
    expect(settle).toBeGreaterThan(run.indexOf('invoke("ade_update_download")'))
    expect(run.indexOf('invoke("ade_update_install")')).toBeGreaterThan(settle)
  })

  test("a take still recording is stopped and waited for before the install, or the install leaves a file nobody can play", () => {
    const run = source.slice(source.indexOf("const runUpdate = async () => {"))
    const settle = run.slice(run.indexOf("settle: () => {"))
    const end = settle.indexOf("save: () => {")
    expect(settle.slice(0, end)).toContain("recorder.stop()")
    expect(settle.indexOf("return takeFinished()")).toBeGreaterThan(settle.indexOf("recorder.stop()"))
    expect(settle.indexOf("return takeFinished()")).toBeLessThan(end)
  })

  test("closing ADE waits for a take that is finishing", () => {
    const close = source.slice(source.indexOf("const closeForGood = "))
    expect(close.slice(0, 160)).toContain("await takeFinished()")
  })
})
