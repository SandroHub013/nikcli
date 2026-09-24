import { describe, expect, test } from "bun:test"
import { HOOK_TIMEOUT } from "../session-new/agent-hooks"
import {
  PASTE_QUIET_MS,
  PASTE_SETTLE_MAX_MS,
  asOneLine,
  asSubmittedLine,
  confirmDeadline,
  pasteSettled,
  submitCheck,
} from "./typing"

const CR = String.fromCharCode(13)
const LF = String.fromCharCode(10)
const NEL = String.fromCharCode(0x85)
const LS = String.fromCharCode(0x2028)
const PS = String.fromCharCode(0x2029)
const VT = String.fromCharCode(11)
const FF = String.fromCharCode(12)

describe("asOneLine", () => {
  test("a carriage return becomes a space, not a second line", () => {
    // The whole point: a tty reads CR as Enter, so this is the character that
    // turns injected text into a submitted command.
    expect(asOneLine(`red${CR}git push --force`)).toBe("red git push --force")
  })

  test("every break a line discipline honours is flattened", () => {
    for (const breaker of [CR, LF, NEL, LS, PS, VT, FF]) {
      const flattened = asOneLine(`before${breaker}after`)
      expect(flattened).toBe("before after")
    }
  })

  test("a run of breaks collapses to one space", () => {
    expect(asOneLine(`a${CR}${LF}${CR}${LF}b`)).toBe("a b")
  })

  test("text with no breaks is returned unchanged", () => {
    expect(asOneLine("git status --porcelain")).toBe("git status --porcelain")
  })

  /*
   * Oltre ai ritorni a capo, nella stringa possono restare controlli C0/C1
   * che un tty non interpreta come fine riga ma che un terminale esegue:
   * ESC apre sequenze, Ctrl-C può interrompere l'agente. L'utente non li ha
   * detti: vengono tolti, lo spazio no.
   */
  test("control characters are stripped, ordinary spaces stay", () => {
    expect(asOneLine("comando\u001b\u0003fine")).toBe("comandofine")
    expect(asOneLine("a\u0000b c")).toBe("ab c")
    expect(asOneLine("a\u007fb c")).toBe("ab c")
  })

  test("tabs are control characters and go; ordinary spaces stay", () => {
    // Tab is C0 (0x09): same class as ESC, same rule.
    expect(asOneLine("a\tb c")).toBe("ab c")
  })
})

describe("asSubmittedLine", () => {
  test("ends with exactly one carriage return", () => {
    const sent = asSubmittedLine("ciao")
    expect(sent).toBe(`ciao${CR}`)
    expect(sent.split(CR).length - 1).toBe(1)
  })

  test("injected breaks cannot add a second submission", () => {
    const sent = asSubmittedLine(`innocuo${CR}git push --force`)
    expect(sent.split(CR).length - 1).toBe(1)
    expect(sent).toBe(`innocuo git push --force${CR}`)
  })
})

describe("the Enter after a paste", () => {
  test("waits for the program to redraw after the paste, then for quiet", () => {
    // Quiet since before the paste: a long paste is still being taken in.
    expect(pasteSettled({ typedAt: 1000, lastOutputAt: 900, now: 1600 })).toBe(false)
    expect(pasteSettled({ typedAt: 1000, now: 1600 })).toBe(false)
    // Redrawn, still drawing.
    expect(pasteSettled({ typedAt: 1000, lastOutputAt: 2400, now: 2500 })).toBe(false)
    // Redrawn and quiet.
    expect(pasteSettled({ typedAt: 1000, lastOutputAt: 2400, now: 2400 + PASTE_QUIET_MS })).toBe(true)
  })

  test("goes anyway when the program never stops drawing", () => {
    expect(pasteSettled({ typedAt: 1000, lastOutputAt: 8990, now: 1000 + PASTE_SETTLE_MAX_MS })).toBe(true)
  })
})

describe("submitCheck", () => {
  const typedAt = 1000
  const deadline = 13000

  test("attività { state: 'busy', at: 1500 }, now: 2000 → 'confirmed'", () => {
    expect(submitCheck({ typedAt, activity: { state: "busy", at: 1500 }, now: 2000, deadline })).toBe("confirmed")
  })

  test("attività { state: 'idle', at: 1500 }, now: 2000 → 'confirmed' (un turno brevissimo già finito)", () => {
    expect(submitCheck({ typedAt, activity: { state: "idle", at: 1500 }, now: 2000, deadline })).toBe("confirmed")
  })

  test("attività { state: 'busy', at: 500 }, now: 2000 → 'queued'", () => {
    expect(submitCheck({ typedAt, activity: { state: "busy", at: 500 }, now: 2000, deadline })).toBe("queued")
  })

  test("attività { state: 'idle', at: 500 }, now: 4000 → 'wait' (questo è il caso del difetto: a 3 s oggi si rimandava Invio)", () => {
    expect(submitCheck({ typedAt, activity: { state: "idle", at: 500 }, now: 4000, deadline })).toBe("wait")
  })

  test("attività undefined, now: 12999 → 'wait'", () => {
    expect(submitCheck({ typedAt, activity: undefined, now: 12999, deadline })).toBe("wait")
  })

  test("attività { state: 'idle', at: 500 }, now: 13000 → 'resend'", () => {
    expect(submitCheck({ typedAt, activity: { state: "idle", at: 500 }, now: 13000, deadline })).toBe("resend")
  })

  test("attività undefined, now: 13000 → 'resend'", () => {
    expect(submitCheck({ typedAt, activity: undefined, now: 13000, deadline })).toBe("resend")
  })

  test("confirmDeadline(1000, 10) → 13000", () => {
    expect(confirmDeadline(1000, 10)).toBe(13000)
  })

  // Il test sopra fissa la formula con un 10 scritto a mano: se HOOK_TIMEOUT
  // tornasse a 5, quello continuerebbe a passare. Questo no.
  test("la finestra segue HOOK_TIMEOUT, non un numero scritto a mano", () => {
    expect(confirmDeadline(0, HOOK_TIMEOUT)).toBeGreaterThanOrEqual(12_000)
  })
})

