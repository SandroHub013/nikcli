import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { compileSolidJsx } from "../test-support/solid-jsx"
import { codeOf } from "../test-support/source-text"
import { DEFAULT_BINDINGS, FROM_TERMINALS } from "../keyboard/bindings"
import { buildCommands } from "./commands"
import { createWorkbench } from "./state"
import { t } from "../i18n"

/*
 * «In alto a sinistra, di fianco alle sessioni attive, un tasto per mostrare e
 * nascondere la barra laterale, per permettere alle sessioni di riempire tutto
 * lo schermo» — the user's request. A button in the top bar, a palette command
 * and a chord, one state that outlives a restart.
 */
compileSolidJsx()
const { createRoot } = await import("solid-js")
const { render } = await import("solid-js/web")
const { SidebarToggle, SIDEBAR_HIDDEN_KEY, readSidebarHidden, writeSidebarHidden } = await import("./sidebar-toggle")

function mount(props: { hidden: boolean; onToggle: () => void; shortcut?: string }) {
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = createRoot((dispose) => {
    render(() => SidebarToggle(props), host)
    return dispose
  })
  return {
    button: host.querySelector("button") as HTMLButtonElement,
    done: () => {
      dispose()
      host.remove()
    },
  }
}

function memoryStorage() {
  const items = new Map<string, string>()
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  }
}

describe("the sidebar button", () => {
  test("says the state as a toggle does, and the action in its tooltip", () => {
    const shown = mount({ hidden: false, onToggle: () => {}, shortcut: "Ctrl+Shift+B" })
    const hidden = mount({ hidden: true, onToggle: () => {}, shortcut: "Ctrl+Shift+B" })
    try {
      expect(shown.button.getAttribute("aria-pressed")).toBe("true")
      expect(hidden.button.getAttribute("aria-pressed")).toBe("false")
      // One name for both states: the state is in aria-pressed, not in the label.
      expect(shown.button.getAttribute("aria-label")).toBe(t("bar.sidebar"))
      expect(hidden.button.getAttribute("aria-label")).toBe(t("bar.sidebar"))
      expect(shown.button.title).toBe(`${t("bar.sidebar.hide")} (Ctrl+Shift+B)`)
      expect(hidden.button.title).toBe(`${t("bar.sidebar.show")} (Ctrl+Shift+B)`)
      // The bar's icon button: its colours are the tokens every one of them uses.
      expect(shown.button.getAttribute("data-slot")).toBe("ade-icon")
    } finally {
      shown.done()
      hidden.done()
    }
  })

  test("a click toggles", () => {
    let toggles = 0
    const bar = mount({ hidden: false, onToggle: () => toggles++ })
    try {
      bar.button.click()
      expect(toggles).toBe(1)
    } finally {
      bar.done()
    }
  })
})

describe("the hidden state", () => {
  test("outlives a restart, and shown is the default", () => {
    const storage = memoryStorage()
    expect(readSidebarHidden(storage)).toBe(false)
    writeSidebarHidden(storage, true)
    expect(storage.getItem(SIDEBAR_HIDDEN_KEY)).toBe("true")
    expect(readSidebarHidden(storage)).toBe(true)
    writeSidebarHidden(storage, false)
    expect(readSidebarHidden(storage)).toBe(false)
  })

  test("storage that refuses is not an error: the column is simply shown", () => {
    const refusing = {
      getItem: () => {
        throw new Error("denied")
      },
      setItem: () => {
        throw new Error("denied")
      },
      removeItem: () => {
        throw new Error("denied")
      },
    }
    expect(readSidebarHidden(refusing)).toBe(false)
    expect(() => writeSidebarHidden(refusing, true)).not.toThrow()
    expect(readSidebarHidden(undefined)).toBe(false)
  })
})

describe("the chord", () => {
  test("is Ctrl+Shift+B, and Ctrl+B stays with the terminal", () => {
    expect(DEFAULT_BINDINGS.find((binding) => binding.commandId === "sidebar.toggle")?.chord).toBe("mod+shift+b")
    // tmux's prefix and readline's back-a-character: never an ADE chord.
    expect(DEFAULT_BINDINGS.some((binding) => binding.chord === "mod+b")).toBe(false)
  })

  test("works from inside a terminal, since xterm sends nothing for it", () => {
    expect(FROM_TERMINALS.has("sidebar.toggle")).toBe(true)
    // Only it: every other ADE chord still goes to the terminal.
    expect([...FROM_TERMINALS]).toEqual(["sidebar.toggle"])
  })
})

describe("the palette", () => {
  const command = (sidebarHidden: boolean) =>
    buildCommands({
      workbench: createWorkbench(),
      recents: [],
      hasHost: true,
      running: new Set<string>(),
      platform: "other",
      sidebarHidden,
    }).find((entry) => entry.id === "sidebar.toggle")

  test("offers what the command will do, with its shortcut", () => {
    expect(command(false)?.title).toBe(t("bar.sidebar.hide"))
    expect(command(true)?.title).toBe(t("bar.sidebar.show"))
    expect(command(false)?.shortcut).toBe("Ctrl+Shift+B")
  })
})

describe("the workbench", () => {
  const source = codeOf(readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8"))
  const css = codeOf(readFileSync(new URL("../dev.css", import.meta.url), "utf8"))

  test("puts the button beside the project's facts, and runs the command", () => {
    const side = source.slice(source.indexOf(codeOf('data-slot="ade-bar-side" data-side="start"')))
    const bar = side.slice(0, side.indexOf(codeOf('data-slot="ade-bar-center"')))
    expect(bar.indexOf("<SidebarToggle")).toBeGreaterThan(bar.indexOf("<ProjectBar"))
    expect(source).toContain(codeOf('} else if (id === "sidebar.toggle") { toggleSidebar()'))
    expect(source).toContain(codeOf('"sidebar.toggle",'))
  })

  test("hides the column and lets the grid take the width", () => {
    expect(source).toContain(codeOf('data-slot="ade-body" data-sidebar-hidden={sidebarHidden() ? "true" : undefined}'))
    expect(css).toContain(
      codeOf('[data-slot="ade-body"][data-sidebar-hidden] > [data-component="ade-sidebar"] { display: none; }'),
    )
  })

  test("lets the chord through from a terminal and no other", () => {
    expect(source).toContain(
      codeOf('if (isTerminal && resolution.type === "ade" && !FROM_TERMINALS.has(resolution.commandId ?? "")) return'),
    )
  })
})
