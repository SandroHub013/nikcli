import { afterEach, describe, expect, test } from "bun:test"
import { compileSolidJsx } from "../test-support/solid-jsx"
import type { Host } from "../host/shell"
import { typedInstallLine, installExit, watchInstall } from "./install-follow"
import { detectAgents } from "./availability"

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

describe("the launcher with no agent installed (UX-1)", () => {
  test("«Avvia» and Enter are off, and the note says why", async () => {
    const { root, launched } = await mount([])
    expect(launchButtons(root).every((b) => b.disabled)).toBe(true)
    expect(root.querySelector('[data-slot="new-agents-note"]')?.textContent).toContain("Nessun agente installato")
    enter(root)
    launchButtons(root)[0]!.click()
    expect(launched).toEqual([])
  })

  test("while the lookup runs it says so and does not launch", async () => {
    const { root, launched } = await mount([], { never: true })
    expect(launchButtons(root).every((b) => b.disabled)).toBe(true)
    expect(root.querySelector('[data-slot="new-agents-note"]')?.textContent).toContain("Cerco gli agenti")
    enter(root)
    expect(launched).toEqual([])
  })

  test("with an agent installed it launches, and an installed initialAgent is preselected", async () => {
    const { root, launched } = await mount(["claude", "codex"], { initialAgent: "codex" })
    expect(launchButtons(root).some((b) => b.disabled)).toBe(false)
    launchButtons(root)[0]!.click()
    expect(launched).toEqual(["codex"])
    const absent = await mount(["claude"], { initialAgent: "kimi" })
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

describe("the workbench wiring", () => {
  test("a pane for no agent says so, and install panes are watched", async () => {
    const src = await Bun.file(new URL("../surface/workbench.tsx", import.meta.url)).text()
    expect(src).toContain('tellPane(paneId, t("pane.noAgent"))')
    expect(src).toContain("typedInstallLine(input.line)")
    expect(src).toContain("installWatch.set(made.id")
    expect(src).toContain('if (!key && voiceSettings().replyBackend === "mai") key = await copyRaguKey(host)')
  })
})
