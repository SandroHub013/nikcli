import { describe, expect, test } from "bun:test"
import { ALLOWED_LINKS, CREATE_LINK, currentStep, PLATFORM_IDS, stepsOf, STEP_IDS, tileState } from "./steps"

/*
 * Scelta 2: three tiles with their state, then five steps with the point you are at.
 */
describe("a platform's tile", () => {
  test("says «to connect» for a platform that was never switched on", () => {
    expect(tileState(undefined)).toBe("setup")
    expect(tileState({ enabled: false, running: false, connected: false })).toBe("setup")
  })

  test("says «connecting» while it is on and not yet connected, «on» once it is", () => {
    expect(tileState({ enabled: true, running: true, connected: false })).toBe("connecting")
    expect(tileState({ enabled: true, running: true, connected: true })).toBe("on")
  })

  test("says «error» when it is on and stopped, or when the link has an error", () => {
    expect(tileState({ enabled: true, running: false, connected: false })).toBe("error")
    expect(tileState({ enabled: true, running: true, connected: false, lastError: "401" })).toBe("error")
  })

  test("an error left on a link that is off is not shown: it is to connect again", () => {
    expect(tileState({ enabled: false, running: false, connected: false, lastError: "401" })).toBe("setup")
  })
})

describe("the five steps", () => {
  const none = { hasToken: false, tokensReady: false, probed: false, enabled: false, authorized: 0 }

  test("are, in order: create the bot, paste the code, try it, turn it on, pair your account", () => {
    expect([...STEP_IDS]).toEqual(["create", "paste", "test", "on", "pair"])
    expect(stepsOf(none).map((step) => step.id)).toEqual([...STEP_IDS])
  })

  test("a new bot is at the first step", () => {
    expect(currentStep(stepsOf(none))).toBe("create")
    expect(stepsOf(none).every((step) => !step.done)).toBe(true)
  })

  test("a saved code is the end of the first two steps, and the user is at the trial", () => {
    const steps = stepsOf({ ...none, hasToken: true, tokensReady: true })
    expect(steps.filter((step) => step.done).map((step) => step.id)).toEqual(["create", "paste"])
    expect(currentStep(steps)).toBe("test")
  })

  test("Slack's code is saved but not its second one: the user is still pasting", () => {
    const steps = stepsOf({ ...none, hasToken: true, tokensReady: false })
    expect(currentStep(steps)).toBe("paste")
  })

  test("a link that is on has been tried, whether or not the trial was pressed", () => {
    const steps = stepsOf({ ...none, hasToken: true, tokensReady: true, enabled: true })
    expect(steps.find((step) => step.id === "test")?.done).toBe(true)
    expect(currentStep(steps)).toBe("pair")
  })

  test("with an account paired everything is done, and the last step stays the one shown", () => {
    const steps = stepsOf({ hasToken: true, tokensReady: true, probed: true, enabled: true, authorized: 1 })
    expect(steps.every((step) => step.done)).toBe(true)
    expect(currentStep(steps)).toBe("pair")
  })
})

describe("the links of the first step", () => {
  test("there is one per platform, and only https to the place the bot is made", () => {
    expect(Object.keys(CREATE_LINK).sort()).toEqual([...PLATFORM_IDS].sort())
    expect(CREATE_LINK.telegram).toBe("https://t.me/BotFather")
    expect(CREATE_LINK.discord).toBe("https://discord.com/developers/applications")
    expect(CREATE_LINK.slack).toBe("https://api.slack.com/apps")
    for (const link of ALLOWED_LINKS) expect(link.startsWith("https://")).toBe(true)
  })
})
