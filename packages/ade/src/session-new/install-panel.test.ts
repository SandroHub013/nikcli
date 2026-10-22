import { afterEach, describe, expect, test } from "bun:test"
import { compileSolidJsx } from "../test-support/solid-jsx"
import type { Host } from "../host/shell"
import { commandFor, installFor, terminalLine, type InstallOs } from "./install"

/*
 * The form with a missing agent on it: its card opens the install panel, the panel shows the catalogue's command for
 * the system, «Installa» hands that line to the host, and «Ricontrolla» turns the card into a normal one once the
 * PATH has the agent. The host is a fake with a PATH of its own; nothing is installed and nothing runs.
 */
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

interface Fake {
  /** What the host's PATH has now. */
  path: Set<string>
  /** What an installer would add to it, taken in by the next `refreshPath`. */
  registry: Set<string>
  calls: string[]
  host: Host
}

function fakeHost(installed: string[]): Fake {
  const fake: Fake = { path: new Set(installed), registry: new Set(installed), calls: [], host: undefined as never }
  fake.host = {
    probe: async (command: string) => {
      fake.calls.push(`probe ${command}`)
      return fake.path.has(command) ? `C:\\bin\\${command}.exe` : null
    },
    refreshPath: async () => {
      fake.calls.push("refresh")
      const changed = [...fake.registry].some((command) => !fake.path.has(command))
      fake.path = new Set(fake.registry)
      return changed
    },
  } as unknown as Host
  return fake
}

interface Mounted {
  root: HTMLElement
  opened: string[]
  runs: Array<{ agentId: string; label: string; line: string }>
}

async function mount(fake: Fake, os: InstallOs, withInstall = true): Promise<Mounted> {
  const root = document.createElement("div")
  document.body.append(root)
  const mounted: Mounted = { root, opened: [], runs: [] }
  disposers.push(
    render(
      () =>
        SessionNew({
          workspace: "demo",
          os,
          loadHost: async () => fake.host,
          openPage: (url: string) => mounted.opened.push(url),
          ...(withInstall ? { onInstall: (input) => mounted.runs.push(input) } : {}),
        }),
      root,
    ),
  )
  await settle()
  return mounted
}

const card = (root: HTMLElement, id: string) =>
  root.querySelector<HTMLButtonElement>(`[data-slot="new-agent"][data-agent-id="${id}"]`)!
const panel = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-slot="install"]')
const button = (root: HTMLElement, slot: string) => root.querySelector<HTMLButtonElement>(`[data-slot="${slot}"]`)!

describe("the card of a missing agent", () => {
  test("is clickable, and opens the panel for that agent", async () => {
    const { root } = await mount(fakeHost(["claude"]), "linux")
    const cline = card(root, "cline")
    expect(cline.dataset.availability).toBe("assente")
    expect(cline.disabled).toBe(false)
    expect(panel(root)).toBeNull()

    cline.click()
    await settle()
    expect(panel(root)?.dataset.agentId).toBe("cline")
    expect(card(root, "cline").dataset.installing).toBe("true")
  })

  test("does not become the chosen agent: only an installed one is selected by a click", async () => {
    const { root } = await mount(fakeHost(["claude", "codex"]), "linux")
    expect(card(root, "claude-code").dataset.active).toBe("true")
    card(root, "kimi").click()
    await settle()
    expect(card(root, "kimi").dataset.active).toBeUndefined()
    expect(card(root, "claude-code").dataset.active).toBe("true")
    card(root, "codex").click()
    await settle()
    expect(card(root, "codex").dataset.active).toBe("true")
    expect(panel(root)).not.toBeNull()
  })

  test("another missing card moves the panel to that agent", async () => {
    const { root } = await mount(fakeHost([]), "linux")
    card(root, "cline").click()
    await settle()
    card(root, "kilo").click()
    await settle()
    expect(root.querySelectorAll('[data-slot="install"]').length).toBe(1)
    expect(panel(root)?.dataset.agentId).toBe("kilo")
  })

  test("the close button puts the panel away", async () => {
    const { root } = await mount(fakeHost([]), "linux")
    card(root, "cline").click()
    await settle()
    button(root, "install-close").click()
    await settle()
    expect(panel(root)).toBeNull()
  })
})

describe("the panel", () => {
  test("shows the catalogue's command for the system it is on, whole", async () => {
    for (const [os, id] of [
      ["windows", "claude-code"],
      ["linux", "claude-code"],
      ["macos", "crush"],
      ["windows", "cline"],
    ] as const) {
      const { root } = await mount(fakeHost([]), os)
      card(root, id).click()
      await settle()
      const expected = commandFor(installFor(id), os)!.line
      expect([os, id, root.querySelector('[data-slot="install-line"]')?.textContent]).toEqual([os, id, expected])
      disposers.pop()?.()
      document.body.replaceChildren()
    }
  })

  test("«Installa» hands the line the terminal will type, for that agent", async () => {
    const win = await mount(fakeHost([]), "windows")
    card(win.root, "claude-code").click()
    await settle()
    button(win.root, "install-run").click()
    expect(win.runs).toEqual([
      {
        agentId: "claude-code",
        label: "Claude Code",
        line: terminalLine(commandFor(installFor("claude-code"), "windows")!),
      },
    ])
    expect(win.runs[0]?.line).toBe('powershell -NoProfile -Command "irm https://claude.ai/install.ps1 | iex"')

    const nix = await mount(fakeHost([]), "linux")
    card(nix.root, "cline").click()
    await settle()
    button(nix.root, "install-run").click()
    expect(nix.runs[0]?.line).toBe("npm i -g cline")
  })

  test("with no command for the system there is only the page, and nothing to run", async () => {
    const { root, opened, runs } = await mount(fakeHost([]), "windows")
    card(root, "ragu").click()
    await settle()
    expect(root.querySelector('[data-slot="install-line"]')).toBeNull()
    expect(root.querySelector('[data-slot="install-none"]')).not.toBeNull()
    expect(root.querySelector('[data-slot="install-run"]')).toBeNull()
    button(root, "install-page").click()
    expect(opened).toEqual([installFor("ragu")!.page])
    expect(runs).toEqual([])
  })

  test("an agent whose installer puts another program says so and offers the page alone", async () => {
    const { root } = await mount(fakeHost([]), "windows")
    for (const id of ["prime", "ohmypi"]) {
      card(root, id).click()
      await settle()
      expect([id, root.querySelector('[data-slot="install-run"]')]).toEqual([id, null])
      expect([id, root.querySelector('[data-slot="install-caveat"]')?.textContent?.includes("«")]).toEqual([id, true])
    }
  })

  test("the page button opens the project's page", async () => {
    const { root, opened } = await mount(fakeHost([]), "linux")
    card(root, "kimi").click()
    await settle()
    button(root, "install-page").click()
    expect(opened).toEqual([installFor("kimi")!.page])
  })

  test("says which tool is missing when the command needs one, and links to where it comes from", async () => {
    const { root, opened } = await mount(fakeHost([]), "linux")
    card(root, "cline").click()
    await settle()
    const requires = root.querySelector('[data-slot="install-requires"]')
    expect(requires).not.toBeNull()
    expect(requires?.textContent).toContain("npm")
    button(root, "install-link").click()
    expect(opened).toEqual(["https://nodejs.org/en/download"])
  })

  test("does not say a tool is missing when it is there, or when the command needs none", async () => {
    const withNpm = await mount(fakeHost(["npm"]), "linux")
    card(withNpm.root, "cline").click()
    await settle()
    expect(withNpm.root.querySelector('[data-slot="install-requires"]')).toBeNull()

    const script = await mount(fakeHost([]), "linux")
    card(script.root, "kimi").click()
    await settle()
    expect(script.root.querySelector('[data-slot="install-requires"]')).toBeNull()
  })

  test("says where the command was read and when", async () => {
    const { root } = await mount(fakeHost([]), "linux")
    card(root, "kimi").click()
    await settle()
    const text = root.querySelector('[data-slot="install-source"]')?.textContent ?? ""
    expect(text).toContain("github.com/MoonshotAI/kimi-cli")
    expect(text).toContain(installFor("kimi")!.checked)
  })

  test("without anywhere to run it, «Installa» is not offered but the command and the page are", async () => {
    const { root } = await mount(fakeHost([]), "linux", false)
    card(root, "kimi").click()
    await settle()
    expect(root.querySelector('[data-slot="install-run"]')).toBeNull()
    expect(root.querySelector('[data-slot="install-line"]')).not.toBeNull()
  })
})

describe("«Ricontrolla»", () => {
  test("with the PATH not yet updated says so, and the card stays missing", async () => {
    const fake = fakeHost(["claude"])
    const { root } = await mount(fake, "linux")
    card(root, "kimi").click()
    await settle()
    button(root, "install-recheck").click()
    await settle()
    expect(root.querySelector('[data-slot="install-outcome"]')?.textContent).toContain("Ancora non lo trovo")
    expect(card(root, "kimi").dataset.availability).toBe("assente")
    // The message survives the new status the recheck produced: the panel was not rebuilt.
    expect(panel(root)?.dataset.agentId).toBe("kimi")
  })

  test("rereads the PATH first; with the agent on it, the card is normal and can be started", async () => {
    const fake = fakeHost(["claude"])
    const { root } = await mount(fake, "linux")
    card(root, "kimi").click()
    await settle()

    // The installer ran in the terminal pane: it wrote the user's PATH, not ADE's.
    fake.registry.add("kimi")
    expect(fake.path.has("kimi")).toBe(false)
    fake.calls.length = 0
    button(root, "install-recheck").click()
    await settle()

    expect(fake.calls[0]).toBe("refresh")
    expect(card(root, "kimi").dataset.availability).toBe("presente")
    expect(card(root, "kimi").dataset.active).toBe("true")
    expect(panel(root)).toBeNull()
  })

  test("on Windows the form rereads the PATH when it opens, so an agent installed meanwhile is already there", async () => {
    const fake = fakeHost(["claude"])
    fake.registry.add("cline")
    const { root } = await mount(fake, "windows")
    expect(card(root, "cline").dataset.availability).toBe("presente")
    expect(fake.calls[0]).toBe("refresh")
  })

  test("elsewhere the form does not start a login shell just to open", async () => {
    const fake = fakeHost(["claude"])
    fake.registry.add("cline")
    const { root } = await mount(fake, "linux")
    expect(fake.calls).not.toContain("refresh")
    expect(card(root, "cline").dataset.availability).toBe("assente")
  })
})
