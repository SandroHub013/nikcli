import { describe, expect, test } from "bun:test"
import {
  MAX_TEXT,
  formatDelivery,
  formatLateReply,
  formatRequest,
  parseMessage,
  resolveAgent,
  resolveTarget,
  sessionsTable,
  verifySender,
} from "./mailbox"

const panes = [
  { id: "n1-0", title: "Sessione 1 — claude-code", agent: "claude-code", status: "idle" },
  { id: "n2-1", title: "Sessione 2 — codex", agent: "codex", status: "working" },
  { id: "n3-2", title: "Sessione 3 — claude-code", agent: "claude-code", status: "idle" },
]

describe("parseMessage", () => {
  test("a note without a kind is a send, BOM included", () => {
    expect(parseMessage('\ufeff{"from":"n2-1","to":"claude","text":"ciao"}')).toEqual({
      kind: "send",
      from: "n2-1",
      to: "claude",
      text: "ciao",
    })
  })

  test("ask, spawn and reply carry what each needs", () => {
    expect(parseMessage('{"kind":"ask","from":"a","to":"2","text":"fai x"}')).toMatchObject({ kind: "ask", to: "2" })
    expect(parseMessage('{"kind":"spawn","from":"a","agent":"codex","text":"fai x"}')).toMatchObject({
      kind: "spawn",
      agent: "codex",
    })
    expect(parseMessage('{"kind":"reply","from":"b","ref":"171-ab","text":"fatto"}')).toMatchObject({
      kind: "reply",
      ref: "171-ab",
    })
  })

  test("anything missing its target, its text, or with a ref that is a path, is refused", () => {
    expect(parseMessage('{"from":"a","to":"","text":"x"}')).toBeUndefined()
    expect(parseMessage('{"from":"a","to":"b","text":"  "}')).toBeUndefined()
    expect(parseMessage('{"kind":"spawn","from":"a","text":"x"}')).toBeUndefined()
    expect(parseMessage('{"kind":"reply","from":"a","ref":"../x","text":"x"}')).toBeUndefined()
    expect(parseMessage('{"kind":"boh","from":"a","to":"b","text":"x"}')).toBeUndefined()
    expect(parseMessage("not json")).toBeUndefined()
  })
})

describe("resolveTarget", () => {
  test("by id, by number, by exact title", () => {
    expect(resolveTarget(panes, "n2-1")).toEqual({ pane: panes[1] })
    expect(resolveTarget(panes, "#3")).toEqual({ pane: panes[2] })
    expect(resolveTarget(panes, "sessione 2 — codex")).toEqual({ pane: panes[1] })
  })

  test("codex can reach claude by the agent's name when there is one", () => {
    expect(resolveTarget([panes[0]!, panes[1]!], "claude", "n2-1")).toEqual({ pane: panes[0] })
  })

  test("two claude sessions are an error that lists them, never a guess", () => {
    const result = resolveTarget(panes, "claude", "n2-1")
    expect("error" in result && result.error).toContain("usa il numero")
  })

  test("a loose match never picks the sender itself", () => {
    expect(resolveTarget(panes, "claude", "n1-0")).toEqual({ pane: panes[2] })
  })

  test("nothing matching says what does exist", () => {
    const result = resolveTarget(panes, "gemini")
    expect("error" in result && result.error).toContain("1 Sessione 1")
    expect("error" in resolveTarget(panes, "9")).toBe(true)
  })
})

test("verifySender keeps a sender only with that pane's token", () => {
  const tokens: Record<string, string> = { "n1-0": "secret" }
  const tokenOf = (id: string) => tokens[id]
  const note = parseMessage('{"from":"n1-0","token":"secret","to":"2","text":"x"}')!
  expect(verifySender(note, tokenOf).from).toBe("n1-0")
  const forged = parseMessage('{"from":"n1-0","token":"guess","to":"2","text":"x"}')!
  expect(verifySender(forged, tokenOf).from).toBe("")
  const bare = parseMessage('{"from":"n1-0","to":"2","text":"x"}')!
  expect(verifySender(bare, tokenOf).from).toBe("")
  const unknown = parseMessage('{"from":"n9-9","to":"2","text":"x"}')!
  expect(verifySender(unknown, tokenOf).from).toBe("")
})

test("resolveAgent accepts the id, the id without -code, and the label", () => {
  const agents = [
    { id: "claude-code", label: "Claude Code" },
    { id: "codex", label: "Codex" },
  ]
  expect(resolveAgent(agents, "claude")).toEqual({ id: "claude-code" })
  expect(resolveAgent(agents, "Claude Code")).toEqual({ id: "claude-code" })
  expect(resolveAgent(agents, "CODEX")).toEqual({ id: "codex" })
  expect("error" in resolveAgent(agents, "gemini")).toBe(true)
})

describe("what lands in the terminal", () => {
  test("a note arrives on one line, with the way to answer", () => {
    expect(formatDelivery({ text: "riga uno\nriga due" }, panes[1])).toBe(
      '[Messaggio da "Sessione 2 — codex" (codex)]: riga uno riga due — per rispondere: ade-msg send n2-1 "<testo>"',
    )
  })

  test("a request ends with the reply command the caller is blocked on", () => {
    const line = formatRequest("171-ab", "trova i test lenti", panes[0])
    expect(line.startsWith('[Richiesta 171-ab da "Sessione 1 — claude-code" (claude-code)]: trova i test lenti')).toBe(true)
    expect(line.endsWith('ade-msg reply 171-ab "<risultato completo>"')).toBe(true)
  })

  test("a late reply names the request it answers", () => {
    expect(formatLateReply("171-ab", "fatto", panes[1])).toBe(
      '[Risposta alla richiesta 171-ab da "Sessione 2 — codex" (codex)]: fatto',
    )
  })

  test("escape sequences cannot become keystrokes in the other terminal", () => {
    expect(formatDelivery({ text: "ok\u001b[2J\u0003" }, undefined)).toBe("[Messaggio da una sessione ADE]: ok[2J")
  })

  test("a very long text is cut", () => {
    expect(formatDelivery({ text: "a".repeat(MAX_TEXT + 50) }, undefined).endsWith("… [troncato]")).toBe(true)
  })
})

test("sessionsTable lists numbers, ids and titles, and the commands", () => {
  const table = sessionsTable(panes)
  expect(table).toContain("progetto senza progetto (3 sessioni)")
  expect(table).toContain("  1  n1-0  claude-code  idle     Sessione 1 — claude-code")
  expect(table).toContain("ade-msg spawn")
})

describe("by project", () => {
  const mixed = [
    { id: "a1", title: "Claude web", agent: "claude-code", project: "web" },
    { id: "b1", title: "Claude api", agent: "claude-code", project: "api" },
    { id: "a2", title: "Codex web", agent: "codex", project: "web" },
    { id: "b2", title: "Codex api", agent: "codex", project: "api" },
  ]

  test("the list groups each project's sessions under a heading, numbered in that order", () => {
    const table = sessionsTable(mixed)
    expect(table.indexOf("progetto web (2 sessioni)")).toBeLessThan(table.indexOf("progetto api (2 sessioni)"))
    expect(table).toMatch(/1 {2}a1 .*Claude web/)
    expect(table).toMatch(/2 {2}a2 .*Codex web/)
    expect(table).toMatch(/3 {2}b1 .*Claude api/)
  })

  test("numbers follow the grouped order", () => {
    expect(resolveTarget(mixed, "2")).toEqual({ pane: mixed[2] })
  })

  test("a bare agent name goes to the one in the sender's project", () => {
    expect(resolveTarget(mixed, "claude", "b2")).toEqual({ pane: mixed[1] })
    expect(resolveTarget(mixed, "claude", "a2")).toEqual({ pane: mixed[0] })
  })

  test("progetto/nome reaches another project, and progetto/N counts inside it", () => {
    expect(resolveTarget(mixed, "api/claude", "a2")).toEqual({ pane: mixed[1] })
    expect(resolveTarget(mixed, "api/2", "a2")).toEqual({ pane: mixed[3] })
    const missing = resolveTarget(mixed, "mobile/claude")
    expect("error" in missing && missing.error).toContain("Progetti: web, api")
  })

  test("without a sender to go by, the same name in two projects is still an error", () => {
    const result = resolveTarget(mixed, "claude")
    expect("error" in result && result.error).toContain("[web]")
  })
})
