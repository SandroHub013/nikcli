import { describe, expect, test } from "bun:test"
import { AGENTS } from "./agents"
import { defaultAgentId, detectAgents, isProbeable, startable } from "./availability"

const answeringFor = (installed: string[]) => async (command: string) =>
  installed.includes(command) ? `${command} 1.2.3\n` : null

describe("detectAgents", () => {
  test("an agent whose probe answers is present, and carries its version", async () => {
    const statuses = await detectAgents(answeringFor(["claude", "agy"]))
    const claude = statuses.find((s) => s.agent.command === "claude")
    expect(claude?.availability).toBe("presente")
    expect(claude?.version).toBe("claude 1.2.3")
  })

  test("an agent whose probe does not answer is absent, not merely unlisted", async () => {
    const statuses = await detectAgents(answeringFor(["claude"]))
    const kimi = statuses.find((s) => s.agent.command === "kimi")
    expect(kimi?.availability).toBe("assente")
    expect(statuses.length).toBe(AGENTS.length)
  })

  test("a probe that throws counts as absent rather than crashing detection", async () => {
    const statuses = await detectAgents(async () => {
      throw new Error("PATH esploso")
    })
    expect(statuses.every((s) => !isProbeable(s.agent) || s.availability === "assente")).toBe(true)
  })

  test("with no probe nothing is claimed absent", async () => {
    const statuses = await detectAgents(undefined)
    expect(statuses.some((s) => s.availability === "assente")).toBe(false)
    expect(statuses.filter((s) => isProbeable(s.agent)).every((s) => s.availability === "sconosciuto")).toBe(true)
  })

  test("the terminal is not probed: it is the shell, not an agent", async () => {
    let probed = 0
    const statuses = await detectAgents(async (command) => {
      probed += 1
      return command === "" ? null : "ok"
    })
    const terminal = statuses.find((s) => s.agent.id === "terminal")
    expect(terminal?.availability).toBe("presente")
    expect(probed).toBe(AGENTS.filter(isProbeable).length)
  })
})

describe("startable", () => {
  test("drops only the agents known to be absent", async () => {
    const statuses = await detectAgents(answeringFor(["claude"]))
    const ids = startable(statuses).map((s) => s.agent.id)
    expect(ids).toContain("claude-code")
    expect(ids).toContain("terminal")
    expect(ids).not.toContain("kimi")
  })
})

describe("defaultAgentId", () => {
  test("prefers an installed agent over the catalogue order", async () => {
    const statuses = await detectAgents(answeringFor(["kimi"]))
    expect(defaultAgentId(statuses)).toBe("kimi")
  })

  test("never preselects an agent known to be absent", async () => {
    const statuses = await detectAgents(answeringFor([]))
    expect(defaultAgentId(statuses)).toBeUndefined()
  })

  test("falls back to an unknown agent when nothing can be probed", async () => {
    const statuses = await detectAgents(undefined)
    expect(defaultAgentId(statuses)).toBe(AGENTS.find(isProbeable)?.id)
  })
})
