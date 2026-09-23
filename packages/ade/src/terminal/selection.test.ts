import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import {
  copyToClipboard,
  isCopyShortcut,
  configureTerminalSelection,
  createTerminalKeyHandler,
  getTerminal,
  disposeTerminal,
  selectionText,
  copyOnRelease,
} from "./registry"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("terminal selection & copy (S50)", () => {
  describe("isCopyShortcut", () => {
    it("recognizes Ctrl+C as a copy shortcut", () => {
      const event = new KeyboardEvent("keydown", { key: "c", ctrlKey: true })
      expect(isCopyShortcut(event)).toBe(true)
    })

    it("recognizes Cmd+C (Meta+C) as a copy shortcut", () => {
      const event = new KeyboardEvent("keydown", { key: "c", metaKey: true })
      expect(isCopyShortcut(event)).toBe(true)
    })

    it("recognizes uppercase 'C' with Ctrl", () => {
      const event = new KeyboardEvent("keydown", { key: "C", ctrlKey: true })
      expect(isCopyShortcut(event)).toBe(true)
    })

    it("recognizes code KeyC with Ctrl", () => {
      const event = new KeyboardEvent("keydown", { code: "KeyC", ctrlKey: true })
      expect(isCopyShortcut(event)).toBe(true)
    })

    it("recognizes Ctrl+Shift+C (Linux / terminal standard)", () => {
      const event = new KeyboardEvent("keydown", { key: "C", ctrlKey: true, shiftKey: true })
      expect(isCopyShortcut(event)).toBe(true)
    })

    it("rejects plain 'c' without modifier", () => {
      const event = new KeyboardEvent("keydown", { key: "c" })
      expect(isCopyShortcut(event)).toBe(false)
    })

    it("rejects other keys like Ctrl+V or Ctrl+X", () => {
      expect(isCopyShortcut(new KeyboardEvent("keydown", { key: "v", ctrlKey: true }))).toBe(false)
      expect(isCopyShortcut(new KeyboardEvent("keydown", { key: "x", ctrlKey: true }))).toBe(false)
      expect(isCopyShortcut(new KeyboardEvent("keydown", { key: "a", ctrlKey: true }))).toBe(false)
    })
  })

  describe("terminal options & custom key event handler", () => {
    const testId = "test-selection-term"

    beforeEach(() => {
      disposeTerminal(testId)
    })

    afterEach(() => {
      disposeTerminal(testId)
    })

    it("initializes terminal with macOptionClickForcesSelection and rightClickSelectsWord enabled", () => {
      const session = getTerminal(testId)
      expect(session.terminal.options.macOptionClickForcesSelection).toBe(true)
      expect(session.terminal.options.rightClickSelectsWord).toBe(true)
    })

    it("custom key handler intercepts Ctrl+C when terminal has selection and copies text", async () => {
      const session = getTerminal(testId)
      const term = session.terminal

      let copiedText = ""
      const origClipboard = navigator.clipboard
      // Define mock clipboard property
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async (t: string) => {
            copiedText = t
          },
        },
        configurable: true,
      })

      try {
        // Mock selection active
        let hasSel = true
        term.hasSelection = () => hasSel
        term.getSelection = () => "selected output line"
        term.clearSelection = () => {
          hasSel = false
        }

        const customHandler = createTerminalKeyHandler(term)
        const ctrlC = new KeyboardEvent("keydown", { key: "c", ctrlKey: true })
        const handled = customHandler(ctrlC)

        // Returns false to prevent xterm from sending ETX (\x03, SIGINT) to the process
        expect(handled).toBe(false)
        expect(copiedText).toBe("selected output line")
        // Selection must be cleared so subsequent keys don't treat it as selected
        expect(hasSel).toBe(false)
      } finally {
        Object.defineProperty(navigator, "clipboard", {
          value: origClipboard,
          configurable: true,
        })
      }
    })

    it("second Ctrl+C after copying passes through to interrupt the agent (SIGINT)", async () => {
      const session = getTerminal(testId)
      const term = session.terminal

      let hasSel = true
      term.hasSelection = () => hasSel
      term.getSelection = () => "selected line"
      term.clearSelection = () => {
        hasSel = false
      }

      const origClipboard = navigator.clipboard
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async () => {},
        },
        configurable: true,
      })

      try {
        const customHandler = createTerminalKeyHandler(term)
        const ctrlC = new KeyboardEvent("keydown", { key: "c", ctrlKey: true })

        // First Ctrl+C: intercepted to copy, selection is cleared
        expect(customHandler(ctrlC)).toBe(false)
        expect(hasSel).toBe(false)

        // Second Ctrl+C on the same spot: selection is gone, passes through (returns true) for SIGINT
        expect(customHandler(ctrlC)).toBe(true)
      } finally {
        Object.defineProperty(navigator, "clipboard", {
          value: origClipboard,
          configurable: true,
        })
      }
    })

    it("custom key handler passes Ctrl+C through when terminal has no selection", () => {
      const session = getTerminal(testId)
      const term = session.terminal

      term.hasSelection = () => false

      const customHandler = createTerminalKeyHandler(term)
      const ctrlC = new KeyboardEvent("keydown", { key: "c", ctrlKey: true })
      const handled = customHandler(ctrlC)

      // Returns true so Ctrl+C acts as SIGINT in the running process
      expect(handled).toBe(true)
    })

    it("custom key handler preserves voice shortcuts (Mod+Shift+J/K)", () => {
      const session = getTerminal(testId)
      const term = session.terminal
      const customHandler = createTerminalKeyHandler(term)

      const modShiftJ = new KeyboardEvent("keydown", { key: "j", ctrlKey: true, shiftKey: true })
      expect(customHandler(modShiftJ)).toBe(false)

      const modShiftK = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, shiftKey: true })
      expect(customHandler(modShiftK)).toBe(false)
    })
  })

  describe("configureTerminalSelection (S76)", () => {
    const force = () => {
      const service = { shouldForceSelection: (_e: MouseEvent) => false }
      configureTerminalSelection({ _core: { _selectionService: service } } as any)
      return (init: Partial<MouseEvent>) =>
        service.shouldForceSelection({ button: 0, shiftKey: false, altKey: false, ...init } as MouseEvent)
    }

    it("the left button selects with no modifier", () => {
      expect(force()({})).toBe(true)
    })

    it("the left button with Alt goes to the program", () => {
      expect(force()({ altKey: true })).toBe(false)
    })

    it("the right and middle buttons go to the program", () => {
      expect(force()({ button: 2 })).toBe(false)
      expect(force()({ button: 1 })).toBe(false)
    })

    it("the left button with Shift still selects", () => {
      expect(force()({ shiftKey: true })).toBe(true)
    })
  })

  describe("selectionText (S76)", () => {
    const line = (text: string, isWrapped = false) => ({
      isWrapped,
      translateToString: (trim?: boolean, start = 0, end = text.length) => {
        const cut = text.slice(start, end)
        return trim ? cut.replace(/\s+$/, "") : cut
      },
    })

    it("keeps xterm's text in the normal buffer, where the pane's wraps are already joined", () => {
      const terminal = {
        cols: 20,
        buffer: { active: { type: "normal", getLine: () => undefined } },
        getSelection: () => "una riga lunga che il pannello ha mandato a capo",
        getSelectionPosition: () => undefined,
      }
      const text = selectionText(terminal as any)
      expect(text).toBe("una riga lunga che il pannello ha mandato a capo")
      expect(text).not.toContain("\n")
    })

    it("gives one line per screen row in the alternate buffer, wrapped or not, padding cut", () => {
      const rows = [line("prima riga     ", true), line("seconda   ", true), line("terza          ", true)]
      const terminal = {
        cols: 15,
        buffer: { active: { type: "alternate", getLine: (y: number) => rows[y] } },
        getSelection: () => "prima riga     seconda   terza",
        getSelectionPosition: () => ({ start: { x: 0, y: 0 }, end: { x: 15, y: 2 } }),
      }
      expect(selectionText(terminal as any)).toBe("prima riga\nseconda\nterza")
    })

    it("drops the empty lines at the end", () => {
      const terminal = {
        cols: 10,
        buffer: { active: { type: "normal", getLine: () => undefined } },
        getSelection: () => "testo\n   \n\n",
        getSelectionPosition: () => undefined,
      }
      expect(selectionText(terminal as any)).toBe("testo")
    })
  })

  describe("copyOnRelease (S76)", () => {
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
    const setup = (selected: boolean) => {
      const listeners: Array<() => void> = []
      const terminal = {
        hasSelection: () => selected,
        onSelectionChange: (listener: () => void) => {
          listeners.push(listener)
          return { dispose: () => listeners.splice(listeners.indexOf(listener), 1) }
        },
      }
      const element = new EventTarget()
      const release = new EventTarget()
      let copies = 0
      const stop = copyOnRelease(terminal as any, element, release, () => copies++)
      // The order the Architect measured in ADE Test: the mouseup goes through
      // capture and bubble, and only then does xterm report the selection.
      const drag = async () => {
        element.dispatchEvent(new MouseEvent("mousedown", { button: 0 }))
        release.dispatchEvent(new MouseEvent("mouseup", { button: 0 }))
        if (selected) for (const listener of [...listeners]) listener()
        await tick()
      }
      return { drag, copies: () => copies, stop }
    }

    it("copies once when the selection is reported after the release", async () => {
      const { drag, copies } = setup(true)
      await drag()
      expect(copies()).toBe(1)
    })

    it("copies nothing when there is no selection", async () => {
      const { drag, copies } = setup(false)
      await drag()
      expect(copies()).toBe(0)
    })

    it("stops listening when detached", async () => {
      const { drag, copies, stop } = setup(true)
      stop()
      await drag()
      expect(copies()).toBe(0)
    })
  })

  it("the registry never reads the clipboard", () => {
    const source = readFileSync(join(import.meta.dir, "registry.ts"), "utf8")
    expect(source).not.toContain("readText(")
  })

  describe("copyToClipboard", () => {
    it("returns false for empty text", async () => {
      const res = await copyToClipboard("")
      expect(res).toBe(false)
    })

    it("writes to navigator.clipboard when available", async () => {
      let written = ""
      const orig = navigator.clipboard
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async (t: string) => {
            written = t
          },
        },
        configurable: true,
      })
      try {
        const ok = await copyToClipboard("hello world")
        expect(ok).toBe(true)
        expect(written).toBe("hello world")
      } finally {
        Object.defineProperty(navigator, "clipboard", {
          value: orig,
          configurable: true,
        })
      }
    })
  })
})
