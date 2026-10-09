import { describe, expect, test } from "bun:test"
import { tuiSource } from "./tui-source"

describe("onboarding account step removal", () => {
  test("onboarding does not include account login step and app does not import DialogAccountLogin", async () => {
    const onboardingSource = await tuiSource("component/dialog-onboarding.tsx")
    const appSource = await tuiSource("app.tsx")
    expect(onboardingSource).not.toContain("<DialogAccountLogin")
    expect(onboardingSource).not.toContain("STEP.ACCOUNT")
    expect(appSource).not.toContain("DialogAccountLogin")
    expect(appSource).not.toMatch(/DialogLogin\.run\(dialog,\s*sdk\)/)
  })

  test("records onboarding as complete upon wizard finish", async () => {
    const appSource = await tuiSource("app.tsx")
    const marks = appSource.split('kv.set("onboarding_complete", true)')
    expect(marks.length - 1).toBe(1)
  })
})
