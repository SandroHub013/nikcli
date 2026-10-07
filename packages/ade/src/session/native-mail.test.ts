import { describe, expect, test } from "bun:test"

import {
  formatFallbackLine,
  formatHandoff,
  HANDOFF_ACK_MS,
  handoffOutcome,
  isHandoff,
  LATE_NO_MS,
  lateNo,
  nativeLaunchArgs,
  permissionClassIn,
  nativeName,
  parseHandoffs,
  parseNativeSessions,
  routeFor,
} from "./native-mail"

describe("nativeLaunchArgs", () => {
  // Sessioni 2, option (d): no `crossSessionInbound: accept`. The CLI's own rule is permission parity: bypass to bypass passes, a
  // session that asks permission to one that does not is held, so no session of the machine drives a bypass ADE session.
  test("a Claude session gets its name and no inbox setting: the CLI's own rule holds", () => {
    expect(nativeLaunchArgs("claude-code", "Fabio")).toEqual(["--name", "Fabio"])
    expect(nativeLaunchArgs("claude-code", "Fabio")).not.toContain("--settings")
    expect(nativeLaunchArgs("claude-code", "Fabio").join(" ")).not.toContain("crossSessionInbound")
  })

  /** The other ten agents and the shell: nothing changes for them. */
  test("any other agent is started exactly as before", () => {
    for (const agent of ["codex", "nikcli", "agy", "opencode", "kimi", "prime", "pi", "ohmypi", "hermes", "terminal"]) {
      expect(nativeLaunchArgs(agent, "Fabio")).toEqual([])
    }
  })

  test("the name is the title, made safe", () => {
    expect(nativeName("  Revisore  Claude ")).toBe("Revisore Claude")
    expect(nativeName("a\u0007\u0000b")).toBe("a b")
    expect(nativeName("")).toBe("ade")
    expect(nativeName("x".repeat(80)).length).toBe(60)
  })
})

describe("parseNativeSessions", () => {
  const listing = JSON.stringify([
    { pid: 1, cwd: "C:\\a", kind: "interactive", sessionId: "s-1", name: "Fabio", status: "idle" },
    { id: "bg", cwd: "C:\\b", kind: "background", sessionId: "s-2", name: "PLAN.md analysis", state: "blocked" },
    { pid: 3, kind: "interactive", sessionId: "s-3" },
    { pid: 4, kind: "interactive", name: "senza-id" },
    null,
  ])

  test("keeps every row that can be addressed", () => {
    expect(parseNativeSessions(listing)).toEqual([
      { sessionId: "s-1", name: "Fabio" },
      { sessionId: "s-2", name: "PLAN.md analysis" },
    ])
  })

  test("a CLI that does not list gives nobody", () => {
    expect(parseNativeSessions("")).toEqual([])
    expect(parseNativeSessions("error: unknown command 'agents'")).toEqual([])
    expect(parseNativeSessions('{"not":"an array"}')).toEqual([])
    expect(parseNativeSessions("\ufeff[]")).toEqual([])
  })
})

describe("permissionClassIn", () => {
  test("reads the mode bar of a Claude pane: bypass, or one that asks", () => {
    expect(permissionClassIn("⏵⏵ bypass permissions on (shift+tab to cycle)")).toBe("bypass")
    expect(permissionClassIn("manual mode on (shift+tab to cycle)")).toBe("prompting")
    expect(permissionClassIn("⏵⏵ accept edits on")).toBe("prompting")
    expect(permissionClassIn("⏸ plan mode on")).toBe("prompting")
  })

  test("the last mention wins: Shift+Tab repaints the bar, and the old text may still be in the window", () => {
    expect(permissionClassIn("bypass permissions on ... manual mode on")).toBe("prompting")
    expect(permissionClassIn("manual mode on ... bypass permissions on")).toBe("bypass")
  })

  test("colour codes between the words do not hide it, and no mention means unknown", () => {
    expect(permissionClassIn("\u001b[38;5;211mbypass permissions on\u001b[39m")).toBe("bypass")
    expect(permissionClassIn("nothing about modes here")).toBeUndefined()
    expect(permissionClassIn("auto mode on")).toBeUndefined()
  })
})

describe("lateNo", () => {
  const closed = { how: "confermata" as const, at: 1_000, by: "mittente" as const }
  test("a `no` shortly after the sender's own confirmation still types the message", () => {
    expect(lateNo(closed, 1_000 + 60_000)).toBe("retype")
  })
  test("a `no` long after, or after ADE typed it, or for nothing known, does not", () => {
    expect(lateNo(closed, 1_000 + LATE_NO_MS + 1)).toBe("late")
    expect(lateNo({ how: "digitata", at: 1_000 }, 2_000)).toBe("typed")
    expect(lateNo(undefined, 2_000)).toBe("unknown")
  })
})

describe("routeFor", () => {
  const listed = [{ sessionId: "s-1", name: "Fabio" }]
  const both = {
    senderAgent: "claude-code",
    targetAgent: "claude-code",
    targetSessionId: "s-1",
    listed,
    senderClass: "bypass" as const,
    targetClass: "bypass" as const,
  }

  // Sessioni 2, live proof, test 3: the CLI holds a message from a session that asks permission to one that does not, and answers
  // `success:true` anyway. So ADE picks the way before: native only when both ends are known to be in the same class.
  test("native only when sender and target are in the same permission class, and both are known", () => {
    expect(routeFor({ ...both, senderClass: "prompting", targetClass: "prompting" })).toEqual({ via: "nativa", name: "Fabio" })
    expect(routeFor({ ...both, senderClass: "prompting" })).toEqual({
      via: "digitata",
      reason: "mittente e destinatario hanno permessi di classe diversa (mittente: chiede, destinatario: bypass)",
    })
    expect(routeFor({ ...both, targetClass: "prompting" })).toMatchObject({
      via: "digitata",
      reason: expect.stringContaining("classe diversa"),
    })
    expect(routeFor({ ...both, senderClass: undefined })).toEqual({
      via: "digitata",
      reason: "la modalità di permesso del mittente non è nota",
    })
    expect(routeFor({ ...both, targetClass: undefined })).toEqual({
      via: "digitata",
      reason: "la modalità di permesso del destinatario non è nota",
    })
  })

  test("two Claude sessions, the target listed: native, by the name the CLI kept", () => {
    expect(routeFor(both)).toEqual({ via: "nativa", name: "Fabio" })
  })

  /** Every fallback is a reason ADE can show, never a silent keyboard. */
  test("anything else is typed, and says why", () => {
    expect(routeFor({ ...both, senderAgent: "nikcli" })).toEqual({
      via: "digitata",
      reason: "il mittente non è una sessione Claude",
    })
    expect(routeFor({ ...both, senderAgent: undefined })).toMatchObject({ via: "digitata" })
    expect(routeFor({ ...both, targetAgent: "agy" })).toEqual({
      via: "digitata",
      reason: "il destinatario non è una sessione Claude",
    })
    expect(routeFor({ ...both, targetSessionId: undefined })).toMatchObject({
      via: "digitata",
      reason: expect.stringContaining("non ancora nota"),
    })
    expect(routeFor({ ...both, listed: undefined })).toMatchObject({
      via: "digitata",
      reason: expect.stringContaining("claude agents --json"),
    })
    expect(routeFor({ ...both, listed: [] })).toEqual({
      via: "digitata",
      reason: "destinatario non nell'elenco del CLI",
    })
    expect(routeFor({ ...both, typedRequested: true })).toEqual({ via: "digitata", reason: "chiesta dal mittente" })
    // Told "in coda" once, the sender is gone: a handoff now would reach nobody.
    expect(routeFor({ ...both, alreadyQueued: true })).toEqual({
      via: "digitata",
      reason: "già in coda per la digitazione",
    })
  })

  /** A pane renamed by the CLI (its title was taken) is still found: by conversation, not by name. */
  test("the name comes from the listing, not from the pane", () => {
    const renamed = [{ sessionId: "s-1", name: "Fabio-2" }]
    expect(routeFor({ ...both, listed: renamed })).toEqual({ via: "nativa", name: "Fabio-2" })
  })
})

describe("formatHandoff", () => {
  test("is an ok receipt that names the session and carries the whole line", () => {
    const line = '[Richiesta 1790000000000-aaaa da "Master" (claude-code)]: fai x — Rispondi con ade-msg reply …'
    const receipt = formatHandoff("Fabio", "1790000000000-aaaa", line)
    expect(receipt.startsWith("ok")).toBe(true)
    expect(isHandoff(receipt)).toBe(true)
    expect(receipt).toContain('SendMessage alla sessione "Fabio"')
    expect(receipt).toContain(line)
    expect(receipt).toContain("ade-msg delivered 1790000000000-aaaa")
    expect(receipt).toContain("ade-msg delivered 1790000000000-aaaa no")
    expect(isHandoff('ok: consegnato a 3 "Fabio"')).toBe(false)
  })
})

describe("handoffOutcome", () => {
  const handoff = { at: 10_000 }

  test("waits for the sender's word, then gives up on the keyboard", () => {
    expect(handoffOutcome(handoff, {}, 10_000)).toBe("wait")
    expect(handoffOutcome(handoff, {}, 10_000 + HANDOFF_ACK_MS - 1)).toBe("wait")
    expect(handoffOutcome(handoff, {}, 10_000 + HANDOFF_ACK_MS)).toBe("fallback")
  })

  test("the sender's word decides at once, either way", () => {
    expect(handoffOutcome(handoff, { acked: true }, 10_001)).toBe("delivered")
    expect(handoffOutcome(handoff, { failed: true }, 10_001)).toBe("fallback")
    // Said "no" wins even before the clock.
    expect(handoffOutcome(handoff, { failed: true, acked: true }, 10_001)).toBe("fallback")
  })

  /**
   * Nothing but the sender's word: the live test saw ADE's own reminder open a
   * turn in the target and a hook-based "delivered" swallow a message nobody
   * had sent. The shape of `seen` is the whole guarantee.
   */
  test("the target's turn is not a witness", () => {
    const seen: Parameters<typeof handoffOutcome>[1] = { acked: false }
    expect("turnBeganAt" in seen).toBe(false)
    expect(handoffOutcome(handoff, seen, 10_000 + HANDOFF_ACK_MS - 1)).toBe("wait")
    expect(handoffOutcome(handoff, seen, 10_000 + HANDOFF_ACK_MS)).toBe("fallback")
  })

  test("the typed line says it may be a repeat", () => {
    const typed = formatFallbackLine("[Richiesta x]: fai y", "nessuna conferma dal mittente")
    expect(typed.startsWith("[Richiesta x]: fai y")).toBe(true)
    expect(typed).toContain("nessuna conferma dal mittente")
    expect(typed).toContain("ignora questo doppione")
  })
})

describe("parseHandoffs", () => {
  const handoff = { paneId: "p2", line: "[Richiesta x]: fai y", id: "x", kind: "ask" as const, from: "p1", at: 10_000 }

  test("keeps what a restart needs and nothing else", () => {
    const [kept] = parseHandoffs(JSON.stringify([{ ...handoff, acked: true, stray: 1 }]))
    expect(kept).toEqual(handoff)
    const [withFull] = parseHandoffs(JSON.stringify([{ ...handoff, full: "[Richiesta x]: fai\ny" }]))
    expect(withFull).toEqual({ ...handoff, full: "[Richiesta x]: fai\ny" })
  })

  test("drops what is not a handoff", () => {
    expect(parseHandoffs(null)).toEqual([])
    expect(parseHandoffs("{")).toEqual([])
    expect(parseHandoffs(JSON.stringify([{ ...handoff, kind: "reply" }, { ...handoff, at: "10" }, null, 7]))).toEqual(
      [],
    )
  })

  /** Replayed at start, an old handoff is exactly one the clock has run out on. */
  test("a saved handoff older than the limit falls back on the keyboard", () => {
    const [kept] = parseHandoffs(JSON.stringify([handoff]))
    expect(handoffOutcome(kept, {}, handoff.at + HANDOFF_ACK_MS)).toBe("fallback")
    expect(handoffOutcome(kept, {}, handoff.at + 1)).toBe("wait")
  })
})
