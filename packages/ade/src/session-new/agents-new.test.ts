import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { compileSolidJsx } from "../test-support/solid-jsx"
import { codeOf } from "../test-support/source-text"
import { AGENTS, agentById, isApp } from "./agents"
import { detectAgents } from "./availability"
import { RESUME, lostConversation, resumePromise } from "./resume"
import { startArgsFor } from "../surface/start-args"
import { normalizeAgentId } from "../sidebar/workspace-tree"

/*
 * The agents asked for on 2026-09-27 (`ade-team/results/agenti-mancanti.md`):
 * six CLIs and T3 Code, which is not an agent but a server with a web app.
 */
compileSolidJsx()
const { createRoot } = await import("solid-js")
const { render } = await import("solid-js/web")
const { AgentMark } = await import("./agent-mark")

const NEW: Record<string, string> = {
  freebuff: "freebuff",
  cline: "cline",
  crush: "crush",
  kilo: "kilo",
  goose: "goose",
  copilot: "copilot",
  t3: "t3",
}

function markOf(id: string, colored = true): SVGElement {
  const host = document.createElement("div")
  document.body.append(host)
  createRoot(() => render(() => AgentMark({ id, colored }), host))
  const svg = host.querySelector("svg") as SVGElement
  host.remove()
  return svg
}

describe("the new agents", () => {
  test("are in the catalogue, each with its command", () => {
    for (const [id, command] of Object.entries(NEW)) expect([id, agentById(id)?.command]).toEqual([id, command])
  })

  test("show as absent when their command is not on PATH, like any other", async () => {
    const statuses = await detectAgents(async () => null)
    for (const id of Object.keys(NEW))
      expect([id, statuses.find((status) => status.agent.id === id)?.availability]).toEqual([id, "assente"])
  })

  test("Cline opens its terminal interface: bare, a task would run headless with every step approved", () => {
    expect(startArgsFor("cline", undefined, { title: "t", opening: [] })[0]).toBe("--tui")
    expect(startArgsFor("crush", undefined, { title: "t", opening: [] })).not.toContain("--tui")
  })

  test("T3 Code is an app, not an agent", () => {
    expect(isApp("t3")).toBe(true)
    expect(AGENTS.filter((agent) => agent.kind === "app").map((agent) => agent.id)).toEqual(["t3"])
  })
})

describe("coming back after a restart", () => {
  test("Kilo and Copilot reopen this folder's latest conversation", () => {
    expect(RESUME.kilo?.last?.()).toEqual(["--continue"])
    expect(RESUME.copilot?.last?.()).toEqual(["--continue"])
    expect(resumePromise({ agentId: "kilo" })).toBe("last")
  })

  test("the others start again, and no conversation is announced as lost", () => {
    // goose's --resume is the whole machine's latest; cline wants an id ADE never learns.
    for (const id of ["freebuff", "cline", "crush", "goose", "t3"]) {
      expect([id, id in RESUME]).toEqual([id, false])
      expect([id, lostConversation(id, resumePromise({ agentId: id }), false)]).toEqual([id, false])
    }
  })
})

describe("a pane's agent, read back from its title", () => {
  test("Copilot is not pi, which its name contains", () => {
    expect(normalizeAgentId("Sessione 1 — Copilot CLI")).toBe("copilot")
    expect(normalizeAgentId("pi")).toBe("pi")
  })

  test("each new one is recognised", () => {
    expect(normalizeAgentId("Sessione 2 — Cline")).toBe("cline")
    expect(normalizeAgentId("Sessione 1 — Crush")).toBe("crush")
    expect(normalizeAgentId("Kilo")).toBe("kilo")
    expect(normalizeAgentId("goose")).toBe("goose")
    expect(normalizeAgentId("Freebuff")).toBe("freebuff")
    expect(normalizeAgentId("Sessione 1 — T3 Code")).toBe("t3")
  })
})

describe("the marks", () => {
  test("the four with a published mark draw it", () => {
    for (const id of ["copilot", "cline", "goose", "kilo"]) expect(markOf(id).getAttribute("data-mark")).toBe(id)
  })

  test("the three without one get a neutral monogram, never the red it used to be", () => {
    for (const id of ["crush", "freebuff", "t3"]) {
      const svg = markOf(id)
      expect(svg.getAttribute("data-mark")).toBe("monogram")
      expect(svg.outerHTML).not.toMatch(/#EF4444|239, 68, 68/i)
      expect(svg.querySelector("circle")?.getAttribute("stroke")).toBe("currentColor")
    }
  })
})

describe("the workbench", () => {
  const source = codeOf(readFileSync(new URL("../surface/workbench.tsx", import.meta.url), "utf8"))

  test("types no task into an app's server, and no agent can spawn one", () => {
    expect(source).toContain(codeOf('if (agent?.kind === "app") task = ""'))
    expect(source).toContain(
      codeOf('const SPAWNABLE = AGENTS.filter((agent) => agent.id !== "terminal" && agent.kind !== "app")'),
    )
  })
})
