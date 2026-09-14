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
  formatNudge,
  formatUpdate,
  parseActivity,
  parseOpenRequests,
  shouldRering,
  requestState,
  requestsTable,
  shouldNudge,
  type OpenRequest,
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
    expect(line).toContain('ade-msg reply 171-ab "<sintesi>"')
    expect(line).toContain("ade-msg update 171-ab")
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

describe("orchestration", () => {
  test("close and cancel carry no text; spawn reads --close", () => {
    expect(parseMessage('{"kind":"close","from":"a","to":"3"}')).toMatchObject({ kind: "close", to: "3", text: "" })
    expect(parseMessage('{"kind":"cancel","from":"a","ref":"171-ab"}')).toMatchObject({ kind: "cancel", ref: "171-ab" })
    expect(parseMessage('{"kind":"cancel","from":"a","ref":"../x"}')).toBeUndefined()
    expect(parseMessage('{"kind":"spawn","from":"a","agent":"codex","text":"x","close":true}')).toMatchObject({ autoClose: true })
    expect(parseMessage('{"kind":"spawn","from":"a","agent":"codex","text":"x"}')).toMatchObject({ autoClose: false })
  })

  const request: OpenRequest = { id: "171-ab", kind: "spawn", from: "n1-0", to: "n2-1", at: 0, brief: "trova i test lenti" }

  test("a request's state says what the caller is actually waiting on", () => {
    expect(requestState(request, { running: false, permissionPending: false }, 5_000)).toBe("in avvio")
    expect(requestState(request, { running: false, permissionPending: false }, 60_000)).toBe("sessione chiusa")
    expect(requestState(request, { running: true, permissionPending: true }, 60_000)).toBe("attende un permesso")
    expect(requestState(request, { running: true, permissionPending: false }, 60_000)).toBe("in corso")
  })

  test("a quiet session with an old request is reminded, at most twice and never over a prompt", () => {
    const quiet = { running: true, permissionPending: false, lastOutputAt: 10_000 }
    expect(shouldNudge(request, quiet, 30_000)).toBe(false) // too recent
    expect(shouldNudge(request, quiet, 70_000)).toBe(true)
    expect(shouldNudge(request, { ...quiet, lastOutputAt: 60_000 }, 70_000)).toBe(false) // still talking
    expect(shouldNudge(request, { ...quiet, permissionPending: true }, 70_000)).toBe(false)
    expect(shouldNudge({ ...request, nudges: 1, nudgedAt: 70_000 }, quiet, 100_000)).toBe(false) // gap
    expect(shouldNudge({ ...request, nudges: 1, nudgedAt: 70_000 }, quiet, 200_000)).toBe(true)
    expect(shouldNudge({ ...request, nudges: 2, nudgedAt: 0 }, quiet, 900_000)).toBe(false)
    expect(formatNudge("171-ab", panes[0])).toContain("ade-msg reply 171-ab")
  })

  test("status lists who waits on whom, and how long", () => {
    const table = requestsTable([request], panes, () => "in corso", 125_000)
    expect(table).toContain("171-ab  spawn  2m05s  in corso  Sessione 1 — claude-code → Sessione 2 — codex  trova i test lenti")
    expect(requestsTable([], panes, () => "in corso", 0)).toBe("nessuna richiesta in corso\n")
  })

  test("saved requests survive a restart, and junk does not", () => {
    const saved = JSON.stringify([request, { id: "../x", kind: "ask", from: "", to: "a", at: 1 }, 7])
    expect(parseOpenRequests(saved)).toEqual([request])
    expect(parseOpenRequests("not json")).toEqual([])
  })
})
describe("spawn options, updates and the request contract", () => {
  test("spawn carries name, worktree and model; close carries force", () => {
    expect(
      parseMessage('{"kind":"spawn","from":"a","agent":"codex","text":"x","name":"revisore","worktree":true,"model":"gpt-5"}'),
    ).toMatchObject({ name: "revisore", worktree: true, model: "gpt-5", autoClose: false })
    expect(parseMessage('{"kind":"close","from":"a","to":"3","force":true}')).toMatchObject({ force: true })
    expect(parseMessage('{"kind":"close","from":"a","to":"3"}')).toMatchObject({ force: false })
  })

  test("an update names a known state and has a reason", () => {
    expect(parseMessage('{"kind":"update","from":"b","ref":"171-ab","state":"bloccata","text":"manca la chiave"}')).toMatchObject({
      kind: "update",
      state: "bloccata",
    })
    expect(parseMessage('{"kind":"update","from":"b","ref":"171-ab","state":"finito","text":"x"}')).toBeUndefined()
    expect(parseMessage('{"kind":"update","from":"b","ref":"171-ab","state":"bloccata","text":" "}')).toBeUndefined()
  })

  test("the request says where to work, how to answer briefly, and whether to delegate", () => {
    const line = formatRequest("171-ab", "sistema i test", panes[0], {
      worktree: { path: "C:\\p\\app-ade\\revisore", branch: "ade/revisore" },
      resultsDir: "C:\\p\\app-ade\\revisore\\.ade\\results",
      depth: 1,
      maxDepth: 2,
    })
    expect(line).toContain("worktree C:\\p\\app-ade\\revisore (branch ade/revisore)")
    expect(line).toContain("ESITO, FILE toccati, PROBLEMI, PROSSIMO PASSO")
    expect(line).toContain("C:\\p\\app-ade\\revisore\\.ade\\results\\171-ab.md")
    expect(line).toContain("livello 1 di 2")
    expect(line).toContain("resta aperta")
    expect(formatRequest("x", "t", undefined, { depth: 2, maxDepth: 2 })).toContain("Non avviare altre sessioni")
  })

  test("an update tells the caller how to unblock and resume waiting", () => {
    const text = formatUpdate("171-ab", "decisione", "uso A o B?", panes[1])
    expect(text).toContain("chiede una decisione: uso A o B?")
    expect(text).toContain("ade-msg send n2-1")
    expect(text).toContain("ade-msg wait 171-ab")
  })

  test("a blocked request is not nudged, and status shows why it waits", () => {
    const blocked: OpenRequest = {
      id: "171-ab",
      kind: "ask",
      from: "n1-0",
      to: "n2-1",
      at: 0,
      brief: "x",
      update: { state: "bloccata", text: "manca la chiave API", at: 1 },
    }
    expect(shouldNudge(blocked, { running: true, permissionPending: false, lastOutputAt: 0 }, 900_000)).toBe(false)
    expect(requestsTable([blocked], panes, () => "in corso", 1_000)).toContain("bloccata: manca la chiave API")
  })
})
describe("turn activity from the CLI's hooks", () => {
  const request: OpenRequest = { id: "171-ab", kind: "ask", from: "n1-0", to: "n2-1", at: 1_000, deliveredAt: 1_000, brief: "x" }
  const live = { running: true, permissionPending: false, hooked: true }

  test("an activity file is believed only about the pane's own conversation", () => {
    const text = '{"state":"idle","sessionId":"abc","at":5}'
    expect(parseActivity(text, "abc")).toEqual({ state: "idle", at: 5 })
    expect(parseActivity(text)).toEqual({ state: "idle", at: 5 })
    expect(parseActivity(text, "child")).toBeUndefined()
    expect(parseActivity('{"state":"asleep","at":5}')).toBeUndefined()
    expect(parseActivity(null)).toBeUndefined()
  })

  test("working is never nudged; a turn that ended without a reply is, soon", () => {
    expect(shouldNudge(request, { ...live, activity: { state: "busy", at: 2_000 } }, 900_000)).toBe(false)
    expect(shouldNudge(request, { ...live, activity: { state: "idle", at: 2_000 } }, 10_000)).toBe(false)
    expect(shouldNudge(request, { ...live, activity: { state: "idle", at: 2_000 } }, 30_000)).toBe(true)
    expect(requestState(request, { ...live, activity: { state: "idle", at: 2_000 } }, 30_000)).toBe("inattiva senza risposta")
  })

  test("a line that started no turn gets one more Enter, once, and only with hooks", () => {
    expect(shouldRering(request, live, 10_000)).toBe(false) // too soon
    expect(shouldRering(request, live, 30_000)).toBe(true) // no activity since
    expect(shouldRering(request, { ...live, activity: { state: "busy", at: 1_500 } }, 30_000)).toBe(false) // it started
    expect(shouldRering(request, { ...live, activity: { state: "idle", at: 500 } }, 30_000)).toBe(true) // idle from before
    expect(shouldRering(request, { ...live, activity: { state: "busy", at: 500 } }, 30_000)).toBe(false) // queued behind a turn
    expect(shouldRering({ ...request, rings: 1 }, live, 30_000)).toBe(false)
    expect(shouldRering(request, { ...live, hooked: false }, 30_000)).toBe(false)
    expect(shouldRering(request, { ...live, permissionPending: true }, 30_000)).toBe(false)
  })

  test("relaunch is a message with a target, a model and a fresh flag", () => {
    expect(parseMessage('{"kind":"relaunch","from":"a","to":"revisore","model":"sonnet","fresh":true}')).toMatchObject({
      kind: "relaunch",
      to: "revisore",
      model: "sonnet",
      fresh: true,
    })
  })
})