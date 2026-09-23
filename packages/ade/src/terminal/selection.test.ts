import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import {
  copyToClipboard,
  isCopyShortcut,
  configureTerminalSelection,
  createTerminalKeyHandler,
  getTerminal,
  disposeTerminal,
} from "./registry"

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

  describe("configureTerminalSelection", () => {
    it("configures shouldForceSelection on terminal selection service for left-click with modifiers only", () => {
      // Create mock terminal structure
      const mockSelectionService = {
        shouldForceSelection: (_e: MouseEvent) => false,
      }
      const mockTerminal = {
        _core: {
          _selectionService: mockSelectionService,
        },
      }

      configureTerminalSelection(mockTerminal as any)

      // Shift + Left click forces selection
      expect(
        mockSelectionService.shouldForceSelection({ shiftKey: true, altKey: false, button: 0 } as MouseEvent),
      ).toBe(true)

      // Alt/Option + Left click forces selection
      expect(
        mockSelectionService.shouldForceSelection({ shiftKey: false, altKey: true, button: 0 } as MouseEvent),
      ).toBe(true)

      // Right click (button 2) does NOT force selection, passes to application in mouse mode
      expect(
        mockSelectionService.shouldForceSelection({ shiftKey: false, altKey: false, button: 2 } as MouseEvent),
      ).toBe(false)

      // Right click even with modifiers does NOT force selection
      expect(
        mockSelectionService.shouldForceSelection({ shiftKey: true, altKey: false, button: 2 } as MouseEvent),
      ).toBe(false)

      // Plain left click without modifiers does not force selection (delegates to app in mouse mode)
      expect(
        mockSelectionService.shouldForceSelection({ shiftKey: false, altKey: false, button: 0 } as MouseEvent),
      ).toBe(false)
    })
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
