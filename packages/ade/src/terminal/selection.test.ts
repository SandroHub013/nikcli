import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import {
  copyToClipboard,
  isCopyShortcut,
  configureTerminalSelection,
  programHasWheelOnly,
  createTerminalKeyHandler,
  getTerminal,
  disposeTerminal,
  selectionText,
  copyOnRelease,
} from "./registry"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * A model of the xterm 6 pieces copyOnRelease and the Ctrl+C handler meet, written from its source
 * (node_modules/@xterm/xterm/src/browser), not a fake that fires the listener
 * by hand: the old test did that on every drag, and so gave itself the very
 * change it was meant to prove (nik, barra-versione-seguito point 3).
 *
 * - SelectionService: `_fireEventIfSelectionChanged` compares with the last
 *   selection it fired for and says nothing when it is the same;
 *   `clearSelection` fires without recording that; `setSelection` goes
 *   through the comparison. The redraw is queued for the next frame.
 * - DomRenderer: `handleSelectionChanged` empties the layer and returns early
 *   for an empty selection, without touching its `_selectionRenderModel`;
 *   `handleResize` redraws from that model; `refresh` redraws rows only.
 */
type Cell = [number, number]
const same = (a?: Cell, b?: Cell) => !!a && !!b && a[0] === b[0] && a[1] === b[1]

function xterm() {
  const listeners: Array<() => void> = []
  let start: Cell | undefined
  let end: Cell | undefined
  let old: { start?: Cell; end?: Cell; has: boolean } = { has: false }
  let frame: (() => void) | undefined
  // DomRenderer's `_selectionRenderModel` and the divs in `.xterm-selection`.
  let renderModel: { start?: Cell; end?: Cell } = {}
  let divs = 0

  const has = () => !!start && !!end && !same(start, end)
  const fire = () => {
    for (const listener of [...listeners]) listener()
  }
  const fireIfChanged = () => {
    const hasNow = has()
    if (!hasNow) {
      if (old.has) {
        old = { start, end, has: false }
        fire()
      }
      return
    }
    if (!old.start || !old.end || !same(start, old.start) || !same(end, old.end)) {
      old = { start, end, has: true }
      fire()
    }
  }
  const renderSelection = (s?: Cell, e?: Cell) => {
    divs = 0
    if (!s || !e) return // the early return: the model keeps what it had
    if (same(s, e)) {
      renderModel = {} // SelectionRenderModel.update → clear()
      return
    }
    renderModel = { start: s, end: e }
    divs = Math.min(3, e[1] - s[1] + 1)
  }
  const refresh = () => {
    frame ??= () => {
      frame = undefined
      renderSelection(start, end)
    }
  }
  const terminal = {
    rows: 24,
    hasSelection: has,
    onSelectionChange: (listener: () => void) => {
      listeners.push(listener)
      return { dispose: () => listeners.splice(listeners.indexOf(listener), 1) }
    },
    clearSelection: () => {
      start = end = undefined
      refresh()
      fire()
    },
    select: (col: number, row: number, length: number) => {
      start = [col, row]
      end = [col + length, row]
      refresh()
      fireIfChanged()
    },
    refresh: (_from: number, _to: number) => {},
    // What the Ctrl+C handler reads to copy: a normal buffer, so `getSelection`.
    buffer: { active: { type: "normal" } },
    getSelection: () => (has() ? "selected output line" : ""),
    getSelectionPosition: () =>
      has() ? { start: { x: start![0], y: start![1] }, end: { x: end![0], y: end![1] } } : undefined,
  }
  return {
    terminal,
    /** The user drags over `from`..`to`; xterm's own mouseup runs after ours (capture). */
    drag(element: EventTarget, release: EventTarget, from?: Cell, to?: Cell) {
      element.dispatchEvent(new MouseEvent("mousedown", { button: 0 }))
      start = from
      end = to
      // The move is drawn frame by frame while the button is down.
      refresh()
      frame?.()
      release.dispatchEvent(new MouseEvent("mouseup", { button: 0 }))
      fireIfChanged()
    },
    /** The next animation frame, then the decision's turn. */
    async settle() {
      await new Promise((resolve) => setTimeout(resolve, 0))
      frame?.()
    },
    resize() {
      renderSelection(renderModel.start, renderModel.end)
    },
    divs: () => divs,
  }
}

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

    describe("Ctrl+C on a selection, on the xterm model", () => {
      let written: string[] = []
      let origClipboard: Clipboard
      beforeEach(() => {
        written = []
        origClipboard = navigator.clipboard
        Object.defineProperty(navigator, "clipboard", {
          value: { writeText: async (t: string) => void written.push(t) },
          configurable: true,
        })
      })
      afterEach(() => {
        Object.defineProperty(navigator, "clipboard", { value: origClipboard, configurable: true })
      })

      /** The user drags over `from`..`to` (no copy on release here), then presses Ctrl+C. */
      const selectThenCtrlC = async (model: ReturnType<typeof xterm>, from: Cell, to: Cell) => {
        model.drag(new EventTarget(), new EventTarget(), from, to)
        await model.settle()
        const handled = createTerminalKeyHandler(model.terminal as any)(
          new KeyboardEvent("keydown", { key: "c", ctrlKey: true }),
        )
        await model.settle()
        return handled
      }

      it("copies the selection and keeps Ctrl+C from the program", async () => {
        const model = xterm()
        expect(await selectThenCtrlC(model, [2, 3], [10, 5])).toBe(false)
        expect(written).toEqual(["selected output line"])
      })

      // Verifiche: «Copiato» came on release and not on Ctrl+C.
      it("says it copied, as a copy on release does", async () => {
        const model = xterm()
        model.drag(new EventTarget(), new EventTarget(), [2, 3], [10, 5])
        await model.settle()
        let said = 0
        createTerminalKeyHandler(
          model.terminal as any,
          undefined,
          () => said++,
        )(new KeyboardEvent("keydown", { key: "c", ctrlKey: true }))
        await model.settle()
        expect(said).toBe(1)
      })

      it("lint: the pane's onCopied reaches the Ctrl+C handler", () => {
        const source = readFileSync(join(import.meta.dir, "registry.ts"), "utf8")
        expect(source).toContain("() => created.copied?.(),")
        expect(source).toContain("session.copied = options.onCopied")
      })

      it("after the copy a resize draws no teal block", async () => {
        const model = xterm()
        await selectThenCtrlC(model, [2, 3], [10, 5])
        expect(model.divs()).toBe(0)
        // The fit after a resize: DomRenderer.handleResize redraws from its model.
        model.resize()
        expect(model.divs()).toBe(0)
      })

      it("a second Ctrl+C passes through to interrupt the agent (SIGINT)", async () => {
        const model = xterm()
        await selectThenCtrlC(model, [2, 3], [10, 5])
        expect(model.terminal.hasSelection()).toBe(false)
        const again = createTerminalKeyHandler(model.terminal as any)(
          new KeyboardEvent("keydown", { key: "c", ctrlKey: true }),
        )
        expect(again).toBe(true)
        expect(written).toHaveLength(1)
      })
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

    /*
     * Mouse sessions: while the program has asked for the mouse, a plain click
     * is the program's (OpenCode runs the entry clicked, Grok takes it), and
     * Shift+drag selects, as in the common terminals. It was the other way
     * round: the left button always selected, and the program had it only with Alt.
     */
    it("the plain left button goes to the program that asked for the mouse", () => {
      expect(force()({})).toBe(false)
    })

    it("Shift+drag selects", () => {
      expect(force()({ shiftKey: true })).toBe(true)
    })

    it("Alt no longer forces anything: the click is the program's", () => {
      expect(force()({ altKey: true })).toBe(false)
    })

    it("the right and middle buttons go to the program", () => {
      expect(force()({ button: 2 })).toBe(false)
      expect(force()({ button: 1 })).toBe(false)
      expect(force()({ button: 2, shiftKey: true })).toBe(false)
    })
  })

  /* Verifiche's test of step A, live: ade-team/results/mouse-sessioni-prova.md. */
  describe("the program's click, on the live page", () => {
    it("xterm listens on the page's document, not on the template's that holds the pane when it opens", () => {
      const pageId = "test-selection-page-document"
      try {
        expect(getTerminal(pageId).terminal.options.documentOverride).toBe(document)
      } finally {
        disposeTerminal(pageId)
      }
      /*
       * And xterm's open() takes it over the parent's document. Read from its
       * source: happy-dom's `document` is no `instanceof Document`, so open()
       * cannot be watched doing it here; in WebView2 it is.
       */
      const source = readFileSync(
        join(require.resolve("@xterm/xterm/package.json"), "..", "src/browser/CoreBrowserTerminal.ts"),
        "utf8",
      )
      expect(source).toMatch(
        /this\._document = parent\.ownerDocument;\s+if \(this\.options\.documentOverride && this\.options\.documentOverride instanceof Document\) \{\s+this\._document = this\.optionsService\.rawOptions\.documentOverride as Document;/,
      )
      expect(source).toContain("this._document!.addEventListener('mouseup', requestedEvents.mouseup);")
    })

    const service = () => {
      const cleared: number[] = []
      const sel: any = {
        _enabled: true,
        _dragScrollIntervalTimer: undefined as number | undefined,
        shouldForceSelection: () => false,
        disable() {
          cleared.push(1)
          this._enabled = false
        },
      }
      return { sel, cleared }
    }

    it("the program asking for the mouse mid-drag does not clear a Shift+drag just begun", () => {
      const { sel, cleared } = service()
      configureTerminalSelection({ _core: { _selectionService: sel } } as any)
      sel._dragScrollIntervalTimer = 7
      sel.disable()
      expect(cleared).toEqual([])
      expect(sel._enabled).toBe(false)
      sel._dragScrollIntervalTimer = undefined
      sel.disable()
      expect(cleared).toEqual([1])
    })

    it("attaching again does not wrap xterm's disable twice", () => {
      const { sel, cleared } = service()
      configureTerminalSelection({ _core: { _selectionService: sel } } as any)
      configureTerminalSelection({ _core: { _selectionService: sel } } as any)
      sel.disable()
      expect(cleared).toEqual([1])
    })

    it("the names read from xterm's selection are the ones of the xterm installed", () => {
      const source = readFileSync(
        join(require.resolve("@xterm/xterm/package.json"), "..", "src/browser/services/SelectionService.ts"),
        "utf8",
      )
      expect(source).toContain("private _dragScrollIntervalTimer: number | undefined;")
      expect(source).toContain("this._dragScrollIntervalTimer = undefined;")
      expect(source).toMatch(/public disable\(\): void \{\s+this\.clearSelection\(\);\s+this\._enabled = false;/)
    })

    /* Claude Code 2.1.284, started by ADE with its clicks off: the wheel is Claude's, the left button ADE's. */
    it("with the program on the wheel only, every left press is ADE's: a drag selects, a click is step B's", () => {
      let wheel = true
      const { sel } = service()
      configureTerminalSelection({ _core: { _selectionService: sel } } as any, undefined, () => wheel)
      const press = (init: Partial<MouseEvent>) =>
        sel.shouldForceSelection({ button: 0, shiftKey: false, ctrlKey: false, metaKey: false, ...init })
      expect(press({})).toBe(true)
      expect(press({ button: 2 })).toBe(false)
      wheel = false
      expect(press({})).toBe(false)
    })

    it("the wheel only is mode 1000 of a pane that asked for it; a program asking for drags keeps its clicks", () => {
      const at = (mouseTrackingMode: string) => ({ modes: { mouseTrackingMode } }) as any
      expect(programHasWheelOnly(at("vt200"), true)).toBe(true)
      expect(programHasWheelOnly(at("vt200"), false)).toBe(false)
      expect(programHasWheelOnly(at("drag"), true)).toBe(false)
      expect(programHasWheelOnly(at("any"), true)).toBe(false)
      expect(programHasWheelOnly(at("none"), true)).toBe(false)
    })

    it("Ctrl+click on a link is ADE's, and the program does not get it too; off a link it is the program's", () => {
      let onLink = false
      const { sel } = service()
      configureTerminalSelection({ _core: { _selectionService: sel } } as any, () => onLink)
      const press = (init: Partial<MouseEvent>) =>
        sel.shouldForceSelection({ button: 0, shiftKey: false, ctrlKey: false, metaKey: false, ...init })
      expect(press({ ctrlKey: true })).toBe(false)
      onLink = true
      expect(press({ ctrlKey: true })).toBe(true)
      expect(press({ metaKey: true })).toBe(true)
      expect(press({})).toBe(false)
      expect(press({ button: 2, ctrlKey: true })).toBe(false)
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
    const setup = () => {
      const model = xterm()
      const element = new EventTarget()
      const release = new EventTarget()
      let copies = 0
      const stop = copyOnRelease(model.terminal as any, element, release, () => copies++)
      const drag = async (from?: Cell, to?: Cell) => {
        model.drag(element, release, from, to)
        await model.settle()
        await model.settle()
      }
      return { model, drag, copies: () => copies, stop }
    }

    it("copies once when the selection is reported after the release", async () => {
      const { drag, copies } = setup()
      await drag([2, 3], [10, 5])
      expect(copies()).toBe(1)
    })

    it("copies nothing when there is no selection", async () => {
      const { drag, copies } = setup()
      await drag()
      expect(copies()).toBe(0)
    })

    it("after the copy a resize draws no teal block (point 2)", async () => {
      const { model, drag } = setup()
      await drag([2, 3], [10, 5])
      expect(model.divs()).toBe(0)
      // The fit after a resize: DomRenderer.handleResize redraws from its model.
      model.resize()
      expect(model.divs()).toBe(0)
    })

    it("the same cells dragged again copy again, and leave no teal (point 3)", async () => {
      const { model, drag, copies } = setup()
      await drag([2, 3], [10, 5])
      await drag([2, 3], [10, 5])
      expect(copies()).toBe(2)
      expect(model.divs()).toBe(0)
    })

    it("nothing is left selected, so Ctrl+C interrupts again", async () => {
      const { model, drag } = setup()
      await drag([2, 3], [10, 5])
      expect(model.terminal.hasSelection()).toBe(false)
    })

    it("lint: the installed xterm still behaves as the model says", () => {
      // The model above is only as good as its reading of xterm. Pinned to the
      // installed source, so an update that changes either behaviour fails here
      // and the model (and forgetSelection) get read again.
      const root = join(Bun.resolveSync("@xterm/xterm/package.json", import.meta.dir), "..", "src", "browser")
      const renderer = readFileSync(join(root, "renderer", "dom", "DomRenderer.ts"), "utf8")
      const service = readFileSync(join(root, "services", "SelectionService.ts"), "utf8")
      // handleResize redraws from the render model, and an empty selection returns
      // before the model is updated.
      expect(renderer).toContain("this.handleSelectionChanged(this._selectionRenderModel.selectionStart")
      expect(renderer).toMatch(/if \(!start \|\| !end\) \{\s*return;\s*\}\s*this\._selectionRenderModel\.update/)
      // clearSelection fires without recording it; setSelection compares.
      expect(service).toMatch(/public clearSelection\(\): void \{[^}]*this\._onSelectionChange\.fire\(\);/)
      expect(service).toMatch(/public setSelection\([^)]*\): void \{[^}]*this\._fireEventIfSelectionChanged\(\);/)
    })

    it("stops listening when detached", async () => {
      const { drag, copies, stop } = setup()
      stop()
      await drag([2, 3], [10, 5])
      expect(copies()).toBe(0)
    })
  })

  it("lint: the registry never reads the clipboard", () => {
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
