import { afterEach, describe, expect, it } from "bun:test"
import { disposeTerminal, getTerminal, modeResetSequence, startOnCleanScreen } from "./registry"
import { DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS } from "./pty-defaults"

const ids: string[] = []
const make = (id: string) => {
  ids.push(id)
  return getTerminal(id)
}
const flush = (id: string, data: string) => new Promise<void>((resolve) => getTerminal(id).terminal.write(data, resolve))

afterEach(() => {
  for (const id of ids.splice(0)) disposeTerminal(id)
})

/*
 * Audit 2026-11-02, SES-9: a terminal made while its pane is not drawn (another project, or hidden by an expansion)
 * was xterm's 80x24 while the process was told the host's 120x30, so a `--resume` laid its history out at 120 columns
 * into 80: the one-word-per-line damage S77 fixed for drawn panes.
 */
describe("a terminal that is not drawn yet", () => {
  it("starts at the size the process is born at when nothing else is known", () => {
    const { terminal } = make("ses9-undrawn")
    expect(terminal.cols).toBe(DEFAULT_PTY_COLS)
    expect(terminal.rows).toBe(DEFAULT_PTY_ROWS)
  })

  it("the default is the host's 120x30", () => {
    expect([DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS]).toEqual([120, 30])
  })
})

/*
 * SES-7: a restart reuses the pane's xterm, and a process killed by `pty_kill` never switches its modes off. The next
 * program (a shell, a Claude Code that does not ask for the mouse) then got every mouse move as typed text, and a
 * shell restarted after vim began in the alternate buffer with no scrollback.
 */
describe("a restart does not inherit the old program's modes", () => {
  it("the reset names every mode a killed TUI leaves on", () => {
    const sequence = modeResetSequence()
    for (const mode of ["1000", "1002", "1003", "1006", "2004", "1004", "1"]) {
      expect(sequence).toContain(`[?${mode}l`)
    }
    expect(sequence).toContain("[!p")
  })

  it("mouse tracking, bracketed paste, application cursor keys and the alternate buffer are off after it", async () => {
    const id = "ses7-modes"
    const { terminal } = make(id)
    await flush(id, "\u001b[?1049h\u001b[?1003h\u001b[?1006h\u001b[?2004h\u001b[?1h\u001b[?1004h")
    expect(terminal.modes.mouseTrackingMode).toBe("any")
    expect(terminal.modes.bracketedPasteMode).toBe(true)
    expect(terminal.modes.applicationCursorKeysMode).toBe(true)
    expect(terminal.buffer.active.type).toBe("alternate")

    startOnCleanScreen(id)
    await flush(id, "")

    expect(terminal.modes.mouseTrackingMode).toBe("none")
    expect(terminal.modes.bracketedPasteMode).toBe(false)
    expect(terminal.modes.applicationCursorKeysMode).toBe(false)
    expect(terminal.modes.sendFocusMode).toBe(false)
    expect(terminal.buffer.active.type).toBe("normal")
  })

  /*
   * Review of ade/residui-gravi, B1: `?1049l` on the normal buffer sends the cursor to 1;1 (xterm restores a cursor
   * saved at 0;0), so the newlines that scroll the screen away started from the top and left rows - 1 old lines on
   * screen, never in the scrollback. Only a pane in the alternate buffer may be sent it.
   */
  it("a shell in the normal buffer with a full screen has its old lines scrolled into the scrollback", async () => {
    const id = "ses7-normal-full"
    const { terminal } = make(id)
    const lines = Array.from({ length: 40 }, (_, number) => `line ${number + 1}`).join("\r\n")
    await flush(id, lines)
    expect(terminal.buffer.active.type).toBe("normal")

    startOnCleanScreen(id)
    await flush(id, "")

    const active = terminal.buffer.active
    expect(active.cursorX).toBe(0)
    expect(active.cursorY).toBe(0)
    const viewport = Array.from({ length: terminal.rows }, (_, row) => active.getLine(active.baseY + row)?.translateToString(true) ?? "")
    expect(viewport.every((row) => row === "")).toBe(true)
    const everything = Array.from({ length: active.length }, (_, row) => active.getLine(row)?.translateToString(true) ?? "")
    expect(everything).toContain("line 40")
    expect(everything).toContain("line 1")
  })

  it("a pane in the alternate buffer leaves it, and the normal screen under it is scrolled away too", async () => {
    const id = "ses7-alt-over-text"
    const { terminal } = make(id)
    await flush(id, "before vim\r\nsecond line\u001b[?1049h\u001b[2Jvim screen")
    expect(terminal.buffer.active.type).toBe("alternate")
    startOnCleanScreen(id)
    await flush(id, "")
    expect(terminal.buffer.active.type).toBe("normal")
    const active = terminal.buffer.active
    const everything = Array.from({ length: active.length }, (_, row) => active.getLine(row)?.translateToString(true) ?? "")
    expect(everything).toContain("before vim")
    expect(active.cursorY).toBe(0)
  })

  it("a clean pane is still left alone", async () => {
    const id = "ses7-clean"
    const { terminal } = make(id)
    startOnCleanScreen(id)
    await flush(id, "")
    expect(terminal.buffer.active.baseY).toBe(0)
    expect(terminal.buffer.active.cursorY).toBe(0)
  })
})
