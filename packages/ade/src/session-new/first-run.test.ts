import { afterEach, describe, expect, test } from "bun:test"
import { compileSolidJsx } from "../test-support/solid-jsx"
import type { Host } from "../host/shell"
import { typedInstallLine, installExit, watchInstall } from "./install-follow"
import { detectAgents } from "./availability"
import { INSTALLS, commandFor, isSavedInstallPane, terminalLine } from "./install"
import { addPane, createWorkbench, toWorkspaceState } from "../surface/state"

compileSolidJsx()
const { render } = await import("solid-js/web")
const { SessionNew } = await import("./session-new")

const disposers: Array<() => void> = []
afterEach(() => {
  while (disposers.length) disposers.pop()?.()
  document.body.replaceChildren()
})
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

async function mount(installed: string[], opts: { never?: boolean; initialAgent?: string } = {}) {
  const root = document.createElement("div")
  document.body.append(root)
  const launched: string[] = []
  const host = { probe: async (c: string) => (installed.includes(c) ? `C:\bin\${c}` : null) } as unknown as Host
  disposers.push(
    render(
      () =>
        SessionNew({
          workspace: "demo",
          os: "linux",
          loadHost: () => (opts.never ? new Promise<Host | undefined>(() => {}) : Promise.resolve(host)),
          onLaunch: (input) => launched.push(input.agentId),
          ...(opts.initialAgent ? { initialAgent: opts.initialAgent } : {}),
        }),
      root,
    ),
  )
  await settle()
  return { root, launched }
}
const launchButtons = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLButtonElement>('[data-slot="new-launch-btn"]')]
const enter = (root: HTMLElement) =>
  root.querySelector<HTMLElement>("section")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))

/* A real PC: the shell is always there, the agents are not. */
const SHELLS = ["cmd", "sh", "zsh", "bash", "powershell"]

describe("the launcher with no agent installed (UX-1)", () => {
  test("a shell does not count as an agent: «Avvia» and Enter are off, and the note says why", async () => {
    const { root, launched } = await mount(SHELLS)
    expect(launchButtons(root).every((b) => b.disabled)).toBe(true)
    expect(root.querySelector('[data-slot="new-agents-note"]')?.textContent).toContain("Nessun agente installato")
    enter(root)
    launchButtons(root)[0]!.click()
    expect(launched).toEqual([])
  })

  test("clicking Terminal turns «Avvia» back on, and it starts a terminal", async () => {
    const { root, launched } = await mount(SHELLS)
    root.querySelector<HTMLButtonElement>('[data-slot="new-agent"][data-agent-id="terminal"]')!.click()
    await settle()
    expect(launchButtons(root).every((b) => !b.disabled)).toBe(true)
    launchButtons(root)[0]!.click()
    expect(launched).toEqual(["terminal"])
  })

  test("while the lookup runs it says so and does not launch", async () => {
    const { root, launched } = await mount([], { never: true })
    expect(launchButtons(root).every((b) => b.disabled)).toBe(true)
    expect(root.querySelector('[data-slot="new-agents-note"]')?.textContent).toContain("Cerco gli agenti")
    enter(root)
    expect(launched).toEqual([])
  })

  test("with an agent installed it launches, and an installed initialAgent is preselected", async () => {
    const { root, launched } = await mount([...SHELLS, "claude", "codex"], { initialAgent: "codex" })
    expect(launchButtons(root).some((b) => b.disabled)).toBe(false)
    launchButtons(root)[0]!.click()
    expect(launched).toEqual(["codex"])
    const absent = await mount([...SHELLS, "claude"], { initialAgent: "kimi" })
    launchButtons(absent.root)[0]!.click()
    expect(absent.launched).toEqual(["claude-code"])
  })
})

describe("the install follow-through (UX-2)", () => {
  test("the typed line exits only on success", () => {
    expect(typedInstallLine("npm i -g cline")).toBe("npm i -g cline && exit")
  })
  test("only a clean exit of a watched pane is looked up", () => {
    const watch = { agentId: "cline", label: "Cline" }
    expect(installExit(watch, { code: 0 })).toBe(true)
    expect(installExit(watch, { code: 1 })).toBe(false)
    expect(installExit(watch, { code: 0, failed: "startFailed" })).toBe(false)
    expect(installExit(undefined, { code: 0 })).toBe(false)
  })
  test("ready when the recheck finds the agent, missing otherwise", async () => {
    const watch = { agentId: "cline", label: "Cline" }
    const found = await detectAgents(async (c) => (c === "cline" ? "/bin/cline" : null))
    const none = await detectAgents(async () => null)
    expect(await watchInstall(watch, async () => found)).toBe("ready")
    expect(await watchInstall(watch, async () => none)).toBe("missing")
    expect(await watchInstall(watch, async () => Promise.reject(new Error("x")))).toBe("missing")
  })
})

describe("an install pane is never run again by ADE (B3)", () => {
  test("it is not saved, so the restore at start cannot type its installer again", () => {
    let wb = addPane(createWorkbench(), {
      id: "i", title: "Installa Claude Code", status: "done", mode: "custom", workspaceId: "web", lines: [],
      model: "terminal", agent: "terminal", task: "irm https://x | iex && exit", installFor: "claude-code",
    })
    wb = addPane(wb, {
      id: "k", title: "Sessione", status: "idle", mode: "custom", workspaceId: "web", lines: [],
      model: "terminal", agent: "terminal", task: "ls",
    })
    expect(toWorkspaceState(wb).panes.map((pane) => pane.id)).toEqual(["k"])
  })

  test("on Windows no catalogue line has a pipe, ampersand or semicolon outside double quotes, so && exit binds to all of it", () => {
    for (const entry of INSTALLS) {
      const command = commandFor(entry, "windows")
      if (!command) continue
      const outside = terminalLine(command).replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''")
      expect([entry.agentId, /[|&;]/.test(outside)]).toEqual([entry.agentId, false])
    }
  })
})

describe("an install pane saved by 0.18.0 is not brought back (R1)", () => {
  test("a Terminal whose task is exactly a catalogue line is recognised, for every system, and nothing else is", () => {
    for (const entry of INSTALLS)
      for (const os of ["windows", "macos", "linux"] as const) {
        const command = commandFor(entry, os)
        if (!command) continue
        const line = terminalLine(command)
        expect([entry.agentId, os, isSavedInstallPane({ agent: "terminal", task: line })]).toEqual([entry.agentId, os, true])
        expect(isSavedInstallPane({ agent: "terminal", task: `${line} && exit` })).toBe(true)
        // Another agent, or the same text typed by hand into a session that is not a terminal, is not one.
        expect(isSavedInstallPane({ agent: "claude-code", task: line })).toBe(false)
      }
    expect(isSavedInstallPane({ agent: "terminal", task: "ls" })).toBe(false)
    expect(isSavedInstallPane({ agent: "terminal" })).toBe(false)
  })

  test("the workbench drops them before either restore path reads the saved list", async () => {
    const src = await Bun.file(new URL("../surface/workbench.tsx", import.meta.url)).text()
    const at = src.indexOf("!isSavedInstallPane(pane)")
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(src.indexOf("setWb(fromWorkspaceState(state))"))
    expect(src).not.toContain("setWb(fromWorkspaceState(savedWorkspace.state))")
  })
})

describe("the workbench wiring", () => {
  test("a pane for no agent says so, and install panes are watched", async () => {
    const src = await Bun.file(new URL("../surface/workbench.tsx", import.meta.url)).text()
    expect(src).toContain('tellPane(paneId, t("pane.noAgent"))')
    expect(src).toContain("typedInstallLine(input.line)")
    expect(src).toContain("installFor: input.agentId")
    // The launcher takes the grid only when the user is still on the install pane, in its project (B2).
    const done = src.slice(src.indexOf("const installFinished"))
    expect(done.indexOf("wb().focusedId === paneId")).toBeGreaterThan(-1)
    expect(done.indexOf("wb().focusedId === paneId")).toBeLessThan(done.indexOf("setStarting(true)"))
    expect(src).toContain('if (!key && voiceSettings().replyBackend === "mai") key = await copyRaguKey(host)')
  })

  test("UX2-4: on mount, SessionNew focuses the section and sets aria-labelledby to its h1", async () => {
    const { root } = await mount(["claude"])
    const section = root.querySelector<HTMLElement>('section[data-component="session-new"]')!
    expect(section.getAttribute("aria-labelledby")).toBe("session-new-title")
    const title = root.querySelector<HTMLElement>("#session-new-title")!
    expect(title).not.toBeNull()
    expect(document.activeElement).toBe(section)
  })
})
