import { describe, expect, test } from "bun:test"
import { resolvePaneState, type PaneState, type PaneStatus } from "../grid/pane-state"
import {
  BODIES,
  PALETTES,
  createSlotBook,
  diffSnapshots,
  hashText,
  lookOf,
  needsResync,
  shopId,
  worldSnapshot,
  type PaneFacts,
} from "./snapshot"
import type { Snapshot } from "./protocol"

type P = Parameters<typeof worldSnapshot>[0]["panes"][number]

const pane = (id: string, over: Partial<P> = {}): P => ({
  id,
  title: id,
  status: "working",
  mode: "—",
  agent: "claude-code",
  model: "claude-code",
  workspaceId: "nikcli",
  projectRoot: "C:/work/nikcli",
  ...over,
})

const open = { name: "nikcli", root: "C:/work/nikcli" }
const noFacts = (): PaneFacts => ({})

const snap = (over: Partial<Parameters<typeof worldSnapshot>[0]> = {}) =>
  worldSnapshot({ panes: [], facts: noFacts, decisions: 0, now: 1000, ...over })

describe("worldSnapshot: the real projects and sessions become shops and agents", () => {
  test("one shop per project open in ADE or holding a session, one agent per session", () => {
    const result = snap({
      open,
      panes: [
        pane("n1", { title: "Dario" }),
        pane("n2", { title: "Lucia" }),
        pane("n3", { title: "Fabio", workspaceId: "voice", projectRoot: "C:/work/voice" }),
      ],
    })
    expect(result.shops.map((shop) => shop.name)).toEqual(["nikcli", "voice"])
    expect(result.agents.map((agent) => [agent.title, agent.shop])).toEqual([
      ["Dario", shopId(open)],
      ["Lucia", shopId(open)],
      ["Fabio", shopId({ name: "voice", root: "C:/work/voice" })],
    ])
  })

  test("the open project has its shop even with no session in it", () => {
    const result = snap({ open })
    expect(result.shops).toEqual([{ id: shopId(open), name: "nikcli" }])
    expect(result.agents).toEqual([])
  })

  test("a file, a browser, a video and every other panel is not a session", () => {
    const result = snap({
      open,
      panes: [
        pane("n1", { title: "Dario" }),
        pane("f1", { filePath: "C:/work/nikcli/a.ts", agent: undefined, model: "—" }),
        pane("b1", { browserUrl: "http://localhost:3000", agent: undefined, model: "—" }),
        pane("v1", { mode: "video", agent: undefined, model: "—" }),
        pane("d1", { mode: "decisions", agent: undefined, model: "—" }),
        pane("nv", { mode: "nikverse", agent: undefined, model: "—" }),
        pane("x1", { agent: undefined, model: "" }),
      ],
    })
    expect(result.agents.map((agent) => agent.paneId)).toEqual(["n1"])
  })

  test("a pane saved without its folder joins the shop of the project it is named after", () => {
    const result = snap({ open, panes: [pane("old", { projectRoot: undefined, workspaceId: "nikcli" })] })
    expect(result.shops).toHaveLength(1)
    expect(result.agents[0]!.shop).toBe(shopId(open))
  })

  test("two folders that share a name are two shops", () => {
    const result = snap({
      panes: [
        pane("a", { workspaceId: "app", projectRoot: "C:/one/app" }),
        pane("b", { workspaceId: "app", projectRoot: "C:/two/app" }),
      ],
    })
    expect(result.shops).toHaveLength(2)
    expect(new Set(result.agents.map((agent) => agent.shop)).size).toBe(2)
  })

  test("each agent's state is the one resolvePaneState gives for the same things", () => {
    const statuses: PaneStatus[] = ["idle", "provisioning", "working", "waiting", "done", "error"]
    const activities = [undefined, "suspended", "running", "attende una risposta", "ade-msg ask x"]
    const factSets: PaneFacts[] = [{}, { exited: true }, { hasActions: true }, { exited: true, hasActions: true }]
    let compared = 0
    for (const status of statuses)
      for (const activity of activities)
        for (const facts of factSets)
          for (const suspended of [false, true]) {
            const p = pane("n1", { status, activity, ...(suspended ? { suspended: true as const } : {}) })
            const expected: PaneState = resolvePaneState({
              status,
              activity: suspended ? "suspended" : activity,
              ...(facts.exited !== undefined ? { exited: facts.exited } : {}),
              ...(facts.hasActions !== undefined ? { hasActions: facts.hasActions } : {}),
            })
            const got = snap({ open, panes: [p], facts: () => facts }).agents[0]!.state
            expect([status, activity, facts, suspended, got]).toEqual([status, activity, facts, suspended, expected])
            compared++
          }
    expect(compared).toBe(6 * 5 * 4 * 2)
  })

  test("the agent's own report beats the label ADE guessed, as in the pane's header", () => {
    const p = pane("n1", { status: "working", activity: "running" })
    const got = snap({ open, panes: [p], facts: () => ({ activity: "attende una risposta" }) }).agents[0]!.state
    expect(got).toBe("ask")
  })

  test("`since` is kept while the state holds and starts again when it changes", () => {
    const first = snap({ open, panes: [pane("n1", { status: "working" })], now: 1000 })
    const same = snap({ open, panes: [pane("n1", { status: "working" })], now: 5000, previous: first })
    expect(same.agents[0]!.since).toBe(1000)
    const changed = snap({ open, panes: [pane("n1", { status: "error" })], now: 9000, previous: same })
    expect(changed.agents[0]!.state).toBe("err")
    expect(changed.agents[0]!.since).toBe(9000)
  })

  test("only names, states, kinds and counters go across: no path, no transcript", () => {
    const secret = "C:/Users/someone/secret-project"
    const result = snap({
      open: { name: "secret-project", root: secret },
      panes: [
        pane("n1", {
          workspaceId: "secret-project",
          projectRoot: secret,
          lines: [{ kind: "note", text: "la chiave è sk-123" }],
          cwd: secret,
          worktree: `${secret}/wt`,
        } as Partial<P>),
      ],
      decisions: 3,
    })
    const wire = JSON.stringify(result)
    expect(wire).not.toContain("Users")
    expect(wire).not.toContain("sk-123")
    expect(wire).not.toContain("wt")
    expect(result.waiting).toEqual({ decisions: 3 })
    expect(Object.keys(result.agents[0]!).sort()).toEqual(["kind", "look", "paneId", "shop", "since", "state", "title"])
    expect(Object.keys(result.shops[0]!).sort()).toEqual(["id", "name"])
  })
})

describe("stable identities", () => {
  test("a shop's id is the same for the same folder, however it is spelled, and differs for another", () => {
    const id = shopId({ name: "nikcli", root: "C:\\work\\nikcli\\" })
    expect(shopId({ name: "nikcli", root: "c:/WORK/nikcli" })).toBe(id)
    expect(shopId({ name: "nikcli", root: "C:/work/other" })).not.toBe(id)
    expect(shopId({ name: "nikcli" })).not.toBe(id)
    expect(shopId({ name: "nikcli" })).toBe(shopId({ name: "nikcli" }))
  })

  test("the hash is the same on every run", () => {
    expect(hashText("")).toBe(2166136261)
    expect(hashText("nikcli")).toBe(hashText("nikcli"))
    expect(hashText("a")).not.toBe(hashText("b"))
  })

  test("a look depends on the title alone and stays inside what the world can draw", () => {
    expect(lookOf("Dario")).toEqual(lookOf("Dario"))
    const seen = new Set<string>()
    for (let i = 0; i < 400; i++) {
      const look = lookOf(`sessione ${i}`)
      expect(look.body).toBeGreaterThanOrEqual(0)
      expect(look.body).toBeLessThan(BODIES)
      expect(look.palette).toBeGreaterThanOrEqual(0)
      expect(look.palette).toBeLessThan(PALETTES)
      seen.add(`${look.body}/${look.palette}`)
    }
    expect(seen.size).toBeGreaterThan(20)
  })

  test("a shop keeps its place; a new one takes the lowest free one and moves nobody; a closed one gives its place back", () => {
    const book = createSlotBook()
    expect([...book.assign(["a", "b", "c"])]).toEqual([["a", 0], ["b", 1], ["c", 2]])
    expect([...book.assign(["a", "b", "c", "d"])]).toEqual([["a", 0], ["b", 1], ["c", 2], ["d", 3]])
    // b closes: the others stay where they are.
    expect(Object.fromEntries(book.assign(["a", "c", "d"]))).toEqual({ a: 0, c: 2, d: 3 })
    // A new one fills the hole, and nobody moves.
    expect(Object.fromEntries(book.assign(["a", "c", "d", "e"]))).toEqual({ a: 0, c: 2, d: 3, e: 1 })
    // The order in which they are listed does not move them either.
    expect(Object.fromEntries(book.assign(["e", "d", "c", "a"]))).toEqual({ a: 0, c: 2, d: 3, e: 1 })
  })

  test("the shops of a snapshot carry their slots when a book is given", () => {
    const slots = createSlotBook()
    const first = snap({ open, panes: [pane("n3", { workspaceId: "voice", projectRoot: "C:/work/voice" })], slots })
    expect(first.shops.map((shop) => [shop.name, shop.slot])).toEqual([["nikcli", 0], ["voice", 1]])
    const second = snap({ panes: [pane("n3", { workspaceId: "voice", projectRoot: "C:/work/voice" })], slots })
    expect(second.shops.map((shop) => [shop.name, shop.slot])).toEqual([["voice", 1]])
  })
})

describe("diffSnapshots: what the world is told", () => {
  const base = (): Snapshot =>
    snap({ open, panes: [pane("n1", { title: "Dario" }), pane("n2", { title: "Lucia" })], now: 1000 })

  test("nothing changed, nothing is sent", () => {
    expect(diffSnapshots(base(), snap({ open, panes: [pane("n1", { title: "Dario" }), pane("n2", { title: "Lucia" })], now: 2000 }))).toEqual([])
  })

  test("a project that opens makes its shop appear, before the people who work in it", () => {
    const next = snap({
      open,
      panes: [
        pane("n1", { title: "Dario" }),
        pane("n2", { title: "Lucia" }),
        pane("n3", { title: "Fabio", workspaceId: "voice", projectRoot: "C:/work/voice" }),
      ],
      now: 2000,
    })
    const events = diffSnapshots(base(), next)
    expect(events.map((event) => event.type)).toEqual(["shop-open", "agent-spawn"])
    expect(events[0]).toEqual({ type: "shop-open", shop: next.shops[1]! })
    expect(events[1]).toEqual({ type: "agent-spawn", agent: next.agents[2]! })
  })

  test("a project that closes makes its shop disappear, after its people", () => {
    const before = snap({
      open,
      panes: [pane("n1"), pane("n3", { title: "Fabio", workspaceId: "voice", projectRoot: "C:/work/voice" })],
      now: 1000,
    })
    const next = snap({ open, panes: [pane("n1")], now: 2000 })
    const events = diffSnapshots(before, next)
    expect(events.map((event) => event.type)).toEqual(["agent-close", "shop-close"])
    expect(events[0]).toEqual({ type: "agent-close", agent: before.agents[1]! })
    expect(events[1]).toEqual({ type: "shop-close", shop: before.shops[1]! })
  })

  test("a session that is born or closes is an agent-spawn or an agent-close", () => {
    const next = snap({ open, panes: [pane("n1", { title: "Dario" }), pane("n4", { title: "Nuova" })], now: 2000 })
    const events = diffSnapshots(base(), next)
    expect(events.map((event) => event.type)).toEqual(["agent-spawn", "agent-close"])
    expect(events[0]).toMatchObject({ agent: { paneId: "n4" } })
    expect(events[1]).toMatchObject({ agent: { paneId: "n2" } })
  })

  test("a state that changes is one `state` event, with when it changed", () => {
    const next = snap({
      open,
      panes: [pane("n1", { title: "Dario", status: "error" }), pane("n2", { title: "Lucia" })],
      now: 2000,
    })
    expect(diffSnapshots(base(), next)).toEqual([{ type: "state", paneId: "n1", state: "err", at: 2000 }])
  })

  test("decisions waiting are told when the number moves, and not before", () => {
    const next = { ...base(), waiting: { decisions: 2 } }
    expect(diffSnapshots(base(), next)).toEqual([{ type: "waiting", decisions: 2 }])
    expect(diffSnapshots(next, next)).toEqual([])
  })

  test("applying the events to the first picture gives the second", () => {
    const before = snap({
      open,
      panes: [pane("n1", { title: "Dario" }), pane("n2", { title: "Lucia", status: "waiting" })],
      now: 1000,
    })
    const after = snap({
      open,
      panes: [
        pane("n1", { title: "Dario", status: "error" }),
        pane("n5", { title: "Nuova", workspaceId: "voice", projectRoot: "C:/work/voice" }),
      ],
      decisions: 1,
      now: 2000,
    })
    const agents = new Map(before.agents.map((agent) => [agent.paneId, agent]))
    const shops = new Map(before.shops.map((shop) => [shop.id, shop]))
    let waiting = before.waiting.decisions
    for (const event of diffSnapshots(before, after)) {
      if (event.type === "shop-open") shops.set(event.shop.id, event.shop)
      else if (event.type === "shop-close") shops.delete(event.shop.id)
      else if (event.type === "agent-spawn") agents.set(event.agent.paneId, event.agent)
      else if (event.type === "agent-close") agents.delete(event.agent.paneId)
      else if (event.type === "state") agents.set(event.paneId, { ...agents.get(event.paneId)!, state: event.state })
      else if (event.type === "waiting") waiting = event.decisions
    }
    expect([...shops.keys()].sort()).toEqual(after.shops.map((shop) => shop.id).sort())
    expect([...agents.keys()].sort()).toEqual(after.agents.map((agent) => agent.paneId).sort())
    expect([...agents.values()].map((agent) => [agent.paneId, agent.state]).sort()).toEqual(
      after.agents.map((agent) => [agent.paneId, agent.state]).sort(),
    )
    expect(waiting).toBe(1)
  })
})

describe("needsResync: what the events cannot say", () => {
  // A fresh book each time: slots follow the order the shops are listed in, as they do on first sight.
  const mk = (panes: P[], project: { name: string; root: string } | undefined = open) =>
    snap({ ...(project ? { open: project } : {}), panes, now: 1, slots: createSlotBook() })
  const dario = () => pane("n1", { title: "Dario" })

  test("a rename, a new kind, a renamed shop or a shop that moved asks for the whole picture again", () => {
    expect(needsResync(mk([dario()]), mk([pane("n1", { title: "Dario 2" })]))).toBe(true)
    expect(needsResync(mk([dario()]), mk([pane("n1", { title: "Dario", agent: "codex", model: "codex" })]))).toBe(true)
    // The same folder under another name: the shop keeps its id, and its sign changes.
    expect(needsResync(mk([dario()]), mk([dario()], { name: "nikcli-2", root: open.root }))).toBe(true)
    // Two shops listed in the other order swap places.
    const voice = pane("n3", { title: "Fabio", workspaceId: "voice", projectRoot: "C:/work/voice" })
    expect(needsResync(mk([voice], open), mk([voice], { name: "voice", root: "C:/work/voice" }))).toBe(true)
  })

  test("a state change, a session born or closed, or a shop opened is something the events can say", () => {
    expect(needsResync(mk([dario()]), mk([pane("n1", { title: "Dario", status: "error" })]))).toBe(false)
    expect(needsResync(mk([dario()]), mk([dario(), pane("n2", { title: "X" })]))).toBe(false)
    expect(needsResync(mk([dario(), pane("n2", { title: "X" })]), mk([dario()]))).toBe(false)
    const voice = pane("n3", { title: "Fabio", workspaceId: "voice", projectRoot: "C:/work/voice" })
    expect(needsResync(mk([dario()]), mk([dario(), voice]))).toBe(false)
  })
})
