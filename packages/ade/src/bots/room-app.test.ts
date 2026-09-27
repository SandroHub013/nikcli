import { describe, expect, test } from "bun:test"
import type { AgentFile } from "./nikcli"
import { EMPTY_LOG, type RoomPay } from "./room"
import {
  createRoomRunner,
  endNote,
  memberName,
  memoryRoomStore,
  payNote,
  parseRooms,
  roomThread,
  type RoomRecord,
  type RoomSeat,
} from "./room-app"
import type { Turn, TurnResult } from "./turn"
import { emptyTalk } from "./talk"

/*
 * B8b: a room's run on three fake bots, through fake turns: nothing starts a
 * real process. Each bot answers from a script, or holds its answer until the
 * test lets it go.
 */

const bot = (id: string): AgentFile => ({ path: `/progetto/.nikcli/agent/${id}.md`, identifier: id }) as AgentFile
const alfa = bot("alfa")
const beta = bot("beta")
const gamma = bot("gamma")

function result(text: string, costUsd = 0, status: TurnResult["status"] = "done"): TurnResult {
  return { status, text, tokens: 0, costUsd, talk: emptyTalk() }
}

interface Call {
  readonly bot: string
  readonly message: string
  readonly thread: string
  readonly cwd?: string
  readonly maxCostUsd?: number
}

function setup(options: {
  scripts?: Record<string, readonly (string | (() => Promise<TurnResult>))[]>
  pays?: Record<string, RoomPay>
  spend?: RoomRecord["spend"]
  testBuild?: boolean
  busy?: readonly string[]
  seatsProblem?: string
}) {
  const room: RoomRecord = {
    id: "r1",
    name: "prova",
    members: [alfa.path, beta.path, gamma.path],
    ...(options.spend ? { spend: options.spend } : {}),
    log: EMPTY_LOG,
    needsYou: false,
    createdAt: 0,
  }
  const store = memoryRoomStore({ rooms: [room] })
  const calls: Call[] = []
  const stopped: string[] = []
  const spoken: Record<string, number> = {}
  let id = 0
  const runner = createRoomRunner({
    store,
    seats: async () =>
      options.seatsProblem
        ? { problem: options.seatsProblem }
        : [alfa, beta, gamma].map(
            (entry): RoomSeat => ({
              member: { id: entry.path, name: entry.identifier },
              bot: entry,
              pay: options.pays?.[entry.identifier] ?? "free",
              cwd: "/progetto",
            }),
          ),
    turns: {
      room: (entry, message, thread, cwd, maxCostUsd) => {
        if (options.busy?.includes(entry.identifier)) return undefined
        calls.push({
          bot: entry.identifier,
          message,
          thread,
          ...(cwd ? { cwd } : {}),
          ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
        })
        const n = (spoken[entry.identifier] = (spoken[entry.identifier] ?? -1) + 1)
        const line = options.scripts?.[entry.identifier]?.[n] ?? "(pass)"
        const turn: Turn = {
          result: typeof line === "string" ? Promise.resolve(result(line)) : line(),
          stop: () => undefined,
        }
        return turn
      },
      stop: (entry) => void stopped.push(entry.identifier),
    },
    testBuild: () => options.testBuild ?? false,
    now: () => 1,
    newId: () => `e${++id}`,
  })
  const current = () => store.get().rooms[0]!
  const said = () =>
    current().log.entries.map((entry) =>
      entry.from.kind === "user" ? `utente: ${entry.text}` : `${entry.from.name}: ${entry.text}`,
    )
  return { runner, store, calls, stopped, current, said }
}

describe("B8b: a room's run, through each bot's own turn", () => {
  test("each member speaks in its own thread for the room, and the memory tags stay out of the room", async () => {
    const r = setup({
      scripts: {
        alfa: ['Ci penso io.\n<ade-memory op="add" block="notes">Stanza prova.</ade-memory>'],
        beta: ["Va bene."],
      },
    })
    expect(await r.runner.send("r1", "chi fa la revisione?")).toBeUndefined()
    expect(r.calls.map((call) => call.thread)).toEqual([
      roomThread("r1", alfa.path),
      roomThread("r1", beta.path),
      roomThread("r1", gamma.path),
      // Round 2: only Alfa has a line it has not read (Beta's); it passes, and the room settles.
      roomThread("r1", alfa.path),
    ])
    expect(r.said()).toEqual(["utente: chi fa la revisione?", "alfa: Ci penso io.", "beta: Va bene."])
    expect(r.calls.every((call) => call.cwd === "/progetto")).toBe(true)
    // The bot reads the room's rules and the new lines, not its own chat.
    expect(r.calls[0]!.message).toContain("[Stanza «prova»]")
    expect(r.calls[0]!.message).toContain("Utente: chi fa la revisione?")
  })

  test("a free model may spend nothing; money gets what is left of the round's cap", async () => {
    const r = setup({ pays: { beta: "plan", gamma: "paid" }, spend: { perRoundUsd: 0.2 }, scripts: { alfa: ["uno"] } })
    await r.runner.send("r1", "via")
    const first = r.calls.slice(0, 3)
    expect(first.map((call) => call.maxCostUsd)).toEqual([0, undefined, 0.2])
  })

  test("in ADE Test a room with a paid member does not start, and says which one", async () => {
    const r = setup({ pays: { gamma: "paid" }, spend: { perRoundUsd: 0.2 }, testBuild: true })
    const problem = await r.runner.send("r1", "via")
    expect(problem).toContain("gamma")
    expect(r.calls).toHaveLength(0)
    expect(r.current().note).toBe(problem)
    expect(r.current().noteKind).toBe("problem")
    // The message is kept: the user sees what was not answered.
    expect(r.said()).toEqual(["utente: via"])
  })

  test("a member that is not trusted stops the room before any turn", async () => {
    const r = setup({ seatsProblem: "@beta non ha la tua fiducia" })
    expect(await r.runner.send("r1", "via")).toBe("@beta non ha la tua fiducia")
    expect(r.calls).toHaveLength(0)
  })

  test("@utente lights «ti serve»; the user's next message puts it out", async () => {
    const r = setup({ scripts: { beta: ["@utente scegli tu il nome"] } })
    await r.runner.send("r1", "come la chiamiamo?")
    expect(r.current().needsYou).toBe(true)
    await r.runner.send("r1", "la chiamiamo prova")
    expect(r.current().needsYou).toBe(false)
  })

  test("a bot busy elsewhere keeps silent; the others go on", async () => {
    const r = setup({ busy: ["alfa"], scripts: { beta: ["ci sono io"] } })
    await r.runner.send("r1", "c'è qualcuno?")
    expect(r.calls.some((call) => call.bot === "alfa")).toBe(false)
    expect(r.said()).toEqual(["utente: c'è qualcuno?", "beta: ci sono io"])
  })

  test("a newer message stops the member speaking, and the old run posts nothing more", async () => {
    let release: (value: TurnResult) => void = () => undefined
    const held = () => new Promise<TurnResult>((resolve) => (release = resolve))
    const r = setup({ scripts: { alfa: [held, "seconda risposta"] } })
    const first = r.runner.send("r1", "prima domanda")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(r.runner.running("r1")).toBe(true)
    const second = r.runner.send("r1", "anzi, seconda domanda")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(r.stopped).toEqual(["alfa"])
    release(result("risposta in ritardo", 0, "stopped"))
    await first
    await second
    expect(r.said()).toEqual(["utente: prima domanda", "utente: anzi, seconda domanda", "alfa: seconda risposta"])
    expect(r.runner.running("r1")).toBe(false)
  })

  test("a failed turn is silence, and a run that hit a bound says so under the room", async () => {
    const r = setup({
      scripts: {
        alfa: [() => Promise.resolve(result("mezza risposta", 0, "error")), "a", "b"],
        beta: ["x", "y", "z"],
        gamma: ["1", "2", "3"],
      },
    })
    await r.runner.send("r1", "parlate")
    expect(r.said()).not.toContain("alfa: mezza risposta")
    expect(r.current().note).toBe(endNote("rounds"))
    // An end is news, not a problem (B8b review): it is drawn plain.
    expect(r.current().noteKind).toBe("end")
    expect(endNote("settled")).toBeUndefined()
    expect(endNote("budget", 0.1)).toContain("0.10 $")
  })
})

describe("B8b: the rooms as saved", () => {
  test("beside each member the form says what it costs; a plan has no dollar cap but uses its quota (B8b review)", () => {
    expect(payNote("plan")).toContain("quota")
    expect(payNote("plan")).toContain("3")
    expect(payNote("paid")).toContain("tetto per giro")
    expect(payNote("free")).toBe("gratuito")
  })

  test("a member is named by its bot, or by its file when the bot is gone", () => {
    expect(memberName([alfa], alfa.path)).toBe("alfa")
    expect(memberName([], "C:\\progetto\\.nikcli\\agent\\revisore.md")).toBe("revisore")
  })

  test("a broken room is dropped, a good one comes back as it was", () => {
    const good: RoomRecord = {
      id: "r1",
      name: "prova",
      members: [alfa.path, beta.path],
      spend: { perRoundUsd: 0.1 },
      log: {
        entries: [{ id: "e1", from: { kind: "bot", id: alfa.path, name: "alfa" }, text: "ciao", at: 3 }],
        seen: { [alfa.path]: 1 },
      },
      needsYou: true,
      note: "ferma",
      noteKind: "end",
      createdAt: 7,
    }
    const saved = JSON.stringify({ rooms: [good, { id: "r2" }, { ...good, id: "r3", members: [] }] })
    expect(parseRooms(saved)).toEqual({ rooms: [good] })
    expect(parseRooms("non json")).toEqual({ rooms: [] })
  })

  test("a cap outside the range and a place past the log are not read back", () => {
    const saved = JSON.stringify({
      rooms: [
        { id: "r1", name: "x", members: ["a", "b"], spend: { perRoundUsd: 99 }, log: { entries: [], seen: { a: 5 } } },
      ],
    })
    const room = parseRooms(saved).rooms[0]!
    expect(room.spend).toBeUndefined()
    expect(room.log.seen).toEqual({ a: 0 })
  })
})

/* Verifiche: the room kept silent while a trust dialog waited for the user. */
describe("a room waiting on a trust dialog", () => {
  test("says so while the dialog is open, and stops saying it when the answer comes, or the check fails", async () => {
    const said: [string, boolean][] = []
    let answer: (() => void) | undefined
    const store = memoryRoomStore({
      rooms: [{ id: "r", name: "stanza", members: [], log: EMPTY_LOG, needsYou: false, createdAt: 0 }],
    })
    const runner = createRoomRunner({
      store,
      seats: async (_room, asking) => {
        asking(true)
        await new Promise<void>((resolve) => (answer = resolve))
        asking(false)
        return { problem: "negato" }
      },
      turns: { room: () => undefined, stop: () => {} },
      testBuild: () => false,
      onAsking: (roomId, waiting) => void said.push([roomId, waiting]),
    })
    // Two members, or the size check refuses before any dialog.
    store.set({ rooms: [{ ...store.get().rooms[0]!, members: ["/a.md", "/b.md"] }] })
    const sent = runner.send("r", "ciao")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(said).toEqual([["r", true]])
    answer!()
    await sent
    expect(said.at(-1)).toEqual(["r", false])

    // A check that throws mid-dialog leaves the room not waiting either.
    said.length = 0
    const failing = createRoomRunner({
      store,
      seats: async (_room, asking) => {
        asking(true)
        throw new Error("dialogo chiuso")
      },
      turns: { room: () => undefined, stop: () => {} },
      testBuild: () => false,
      onAsking: (roomId, waiting) => void said.push([roomId, waiting]),
    })
    await failing.send("r", "di nuovo").catch(() => undefined)
    expect(said.at(-1)).toEqual(["r", false])
  })
})
