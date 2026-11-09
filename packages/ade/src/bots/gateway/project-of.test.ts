import { describe, expect, test } from "bun:test"
import { linkDied, projectOfLink, stopTurnsOfDeadLink } from "./project-of"

describe("the project a chat message runs in", () => {
  const on = { bot: "b", platform: "telegram", project: "C:/p", enabled: true }

  test("a link that is on gives its project", () => {
    expect(projectOfLink([on], "b", "telegram")).toBe("C:/p")
  })

  test("a link that is switched off gives none, though it keeps its project: no turn starts for a late message (BOT-2)", () => {
    expect(projectOfLink([{ ...on, enabled: false }], "b", "telegram")).toBeUndefined()
  })

  test("a link with no word on being on still gives its project, and a missing one or another platform gives none", () => {
    const { enabled: _enabled, ...unsaid } = on
    expect(projectOfLink([unsaid], "b", "telegram")).toBe("C:/p")
    expect(projectOfLink([on], "b", "slack")).toBeUndefined()
    expect(projectOfLink([on], "x", "telegram")).toBeUndefined()
    expect(projectOfLink([{ ...on, project: null }], "b", "telegram")).toBeUndefined()
  })

  test("a link a fatal error stopped gives none: a queued turn does not start on it, its answers would be lost (BOT2-2)", () => {
    expect(projectOfLink([{ ...on, running: false, lastError: "401 token revoked" }], "b", "telegram")).toBeUndefined()
  })

  test("a link restarting, not running for an instant and with no error, keeps its project", () => {
    expect(projectOfLink([{ ...on, running: false, lastError: null }], "b", "telegram")).toBe("C:/p")
    expect(projectOfLink([{ ...on, running: true, lastError: "rete giù" }], "b", "telegram")).toBe("C:/p")
  })
})

describe("a link the platform stopped (BOT2-2)", () => {
  const status = { bot: "b", platform: "telegram", enabled: true, running: false, lastError: "401" }

  test("is dead only when it is on, not running, and says why", () => {
    expect(linkDied(status)).toBe(true)
    expect(linkDied({ ...status, enabled: false })).toBe(false)
    expect(linkDied({ ...status, running: true })).toBe(false)
    expect(linkDied({ ...status, lastError: null })).toBe(false)
  })

  test("its turns are stopped, those of a link that is alive are not", () => {
    const off: string[] = []
    const heard = (bot: string, platform: string) => void off.push(`${bot}/${platform}`)
    stopTurnsOfDeadLink(status, heard)
    expect(off).toEqual(["b/telegram"])
    stopTurnsOfDeadLink({ ...status, bot: "vivo", running: true }, heard)
    stopTurnsOfDeadLink({ ...status, bot: "spento", enabled: false }, heard)
    expect(off).toEqual(["b/telegram"])
  })
})
