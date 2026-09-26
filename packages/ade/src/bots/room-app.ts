/**
 * The rooms the user made, and what one message in a room sets off (B8b).
 *
 * `room.ts` holds the rules — who speaks, for how long, within what spend;
 * this holds the rooms and ties a run to the bots' own turns: each member
 * speaks through `BotTurns.room`, in its own thread and session for that
 * room, with the panel's approvals and its memory writes only proposed
 * (`controller.ts`). What a member says in the room is its answer with the
 * memory tags taken out.
 */

import { t } from "../i18n"
import type { BotTurns } from "./controller"
import { takeMemoryOps } from "./memory"
import type { AgentFile } from "./nikcli"
import {
  appendEntry,
  describeProblem,
  EMPTY_LOG,
  LOG_KEPT,
  MAX_MEMBERS,
  memberBudget,
  needsYou,
  ROOM_ROUND_MAX_USD,
  roomProblem,
  roomSpendProblem,
  runRoom,
  type RoomEnd,
  type RoomEntry,
  type RoomLog,
  type RoomMember,
  type RoomPay,
  type RoomSpeaker,
  type RoomSpend,
} from "./room"

export interface RoomRecord {
  readonly id: string
  readonly name: string
  /** The members, by their bot's file. */
  readonly members: readonly string[]
  /** The cap per round, when a member is paid for with money. */
  readonly spend?: RoomSpend
  readonly log: RoomLog
  /** A member wrote @utente since the user last spoke: the room's «ti serve». */
  readonly needsYou: boolean
  /** How the last run ended, or why it could not start. */
  readonly note?: string
  /** An end is news, drawn plain; a problem stopped the room, drawn as one (B8b review). */
  readonly noteKind?: "end" | "problem"
  readonly createdAt: number
}

export interface RoomBook {
  readonly rooms: readonly RoomRecord[]
}

export const EMPTY_ROOMS: RoomBook = { rooms: [] }

/** The thread a member's turns in a room go to: not its own chat. */
export function roomThread(roomId: string, path: string): string {
  return `room:${roomId}:${path}`
}

/** A member's name in the room: its identifier, or its file's name when the bot is gone. */
export function memberName(bots: readonly AgentFile[], path: string): string {
  return bots.find((bot) => bot.path === path)?.identifier ?? (path.split(/[\\/]/).pop() ?? path).replace(/\.md$/i, "")
}

/* ── reading what was saved ───────────────────────────────────────────── */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)

const text = (value: unknown): value is string => typeof value === "string"

function parseSpeaker(value: unknown): RoomSpeaker | undefined {
  if (!isRecord(value)) return undefined
  if (value["kind"] === "user") return { kind: "user" }
  if (value["kind"] === "bot" && text(value["id"]) && text(value["name"])) return { kind: "bot", id: value["id"], name: value["name"] }
  return undefined
}

function parseLog(value: unknown): RoomLog {
  if (!isRecord(value) || !Array.isArray(value["entries"])) return EMPTY_LOG
  const entries: RoomEntry[] = []
  for (const raw of value["entries"].slice(-LOG_KEPT)) {
    if (!isRecord(raw) || !text(raw["id"]) || !text(raw["text"])) continue
    const from = parseSpeaker(raw["from"])
    if (!from) continue
    entries.push({ id: raw["id"], from, text: raw["text"], at: typeof raw["at"] === "number" ? raw["at"] : 0 })
  }
  const seen: Record<string, number> = {}
  if (isRecord(value["seen"])) {
    for (const [id, count] of Object.entries(value["seen"])) {
      if (typeof count === "number" && Number.isInteger(count) && count >= 0) seen[id] = Math.min(count, entries.length)
    }
  }
  return { entries, seen }
}

function parseRoom(value: unknown): RoomRecord | undefined {
  if (!isRecord(value) || !text(value["id"]) || !text(value["name"]) || !Array.isArray(value["members"])) return undefined
  const members = value["members"].filter(text)
  if (members.length === 0 || members.length > MAX_MEMBERS) return undefined
  const spend = isRecord(value["spend"]) ? value["spend"]["perRoundUsd"] : undefined
  const capped = typeof spend === "number" && Number.isFinite(spend) && spend > 0 && spend <= ROOM_ROUND_MAX_USD
  return {
    id: value["id"],
    name: value["name"],
    members,
    ...(capped ? { spend: { perRoundUsd: spend } } : {}),
    log: parseLog(value["log"]),
    needsYou: value["needsYou"] === true,
    ...(text(value["note"]) ? { note: value["note"], noteKind: value["noteKind"] === "end" ? "end" : "problem" } : {}),
    createdAt: typeof value["createdAt"] === "number" ? value["createdAt"] : 0,
  }
}

/** What was saved, as far as it can be trusted: a broken room is dropped, never half-read. */
export function parseRooms(raw: string | null | undefined): RoomBook {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw ?? "null")
  } catch {
    return EMPTY_ROOMS
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["rooms"])) return EMPTY_ROOMS
  return { rooms: parsed["rooms"].map(parseRoom).filter((room): room is RoomRecord => room !== undefined) }
}

export interface RoomStore {
  get: () => RoomBook
  set: (book: RoomBook) => void
}

const STORAGE_KEY = "ade.bots.rooms"

/** In the WebView's storage, like the routines. What the bots said, never a credential. */
export function localRoomStore(key: string = STORAGE_KEY): RoomStore {
  let memory: RoomBook | undefined
  return {
    get: () => {
      try {
        return parseRooms(localStorage.getItem(key))
      } catch {
        return memory ?? EMPTY_ROOMS
      }
    },
    set: (book) => {
      memory = book
      try {
        localStorage.setItem(key, JSON.stringify(book))
      } catch {
        // Storage blocked: the rooms last until ADE closes.
      }
    },
  }
}

export function memoryRoomStore(start: RoomBook = EMPTY_ROOMS): RoomStore {
  let book = start
  return { get: () => book, set: (next) => void (book = next) }
}

export function changeRoom(book: RoomBook, id: string, change: (room: RoomRecord) => RoomRecord): RoomBook {
  return { rooms: book.rooms.map((room) => (room.id === id ? change(room) : room)) }
}

/** What an end says under the room; nothing when it ended the way it should. */
export function endNote(end: RoomEnd, perRoundUsd?: number): string | undefined {
  if (end === "rounds") return t("bots.room.end.rounds")
  if (end === "messages") return t("bots.room.end.messages")
  if (end === "budget") return t("bots.room.end.budget", `${(perRoundUsd ?? 0).toFixed(2)} $`)
  return undefined
}

/* ── one message, one run ─────────────────────────────────────────────── */

/** A member as the run needs it: the room's name for it, the file trusted just now, how it is paid for. */
export interface RoomSeat {
  readonly member: RoomMember
  readonly bot: AgentFile
  readonly pay: RoomPay
  /** The folder its turns run in. */
  readonly cwd?: string
}

export interface RoomRunnerDeps {
  readonly store: RoomStore
  /** The members, trusted as a turn in the panel is (B3, B8c); the problem when one is not. */
  readonly seats: (room: RoomRecord) => Promise<readonly RoomSeat[] | { readonly problem: string }>
  readonly turns: Pick<BotTurns, "room" | "stop">
  /** ADE Test: only free models (B8b brief). */
  readonly testBuild: () => boolean
  readonly changed?: (book: RoomBook) => void
  /** Who is on turn in a room; undefined when nobody is. */
  readonly onTurn?: (roomId: string, path: string | undefined) => void
  readonly now?: () => number
  readonly newId?: () => string
}

export interface RoomRunner {
  /** The user's message; the problem when the room could not run. A run under way ends first. */
  readonly send: (roomId: string, message: string) => Promise<string | undefined>
  /** «Ferma»: no more turns, and the member speaking now is stopped. */
  readonly stop: (roomId: string) => Promise<void>
  readonly running: (roomId: string) => boolean
}

export function createRoomRunner(deps: RoomRunnerDeps): RoomRunner {
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? (() => crypto.randomUUID())
  const runs = new Map<string, { cancelled: boolean; speaking?: AgentFile; done: Promise<unknown> }>()

  const write = (id: string, change: (room: RoomRecord) => RoomRecord) => {
    const next = changeRoom(deps.store.get(), id, change)
    deps.store.set(next)
    deps.changed?.(next)
  }
  const roomOf = (id: string) => deps.store.get().rooms.find((room) => room.id === id)

  const stop = async (roomId: string) => {
    const run = runs.get(roomId)
    if (!run) return
    run.cancelled = true
    if (run.speaking) deps.turns.stop(run.speaking)
    await run.done.catch(() => undefined)
  }

  const send = async (roomId: string, message: string): Promise<string | undefined> => {
    const said = message.trim()
    if (said.length === 0 || !roomOf(roomId)) return undefined
    // A newer message ends the run under way: the room answers this one.
    await stop(roomId)
    write(roomId, (room) => {
      const { note: _old, noteKind: _kind, ...rest } = room
      return {
        ...rest,
        log: appendEntry(room.log, { id: newId(), from: { kind: "user" }, text: said, at: now() }),
        needsYou: false,
      }
    })
    // Held from here, so a message sent while the members are checked ends this run too.
    const run: { cancelled: boolean; speaking?: AgentFile; done: Promise<unknown> } = { cancelled: false, done: Promise.resolve() }
    runs.set(roomId, run)
    const room = roomOf(roomId)!
    const admitted = admit(room)
    run.done = admitted
    const verdict = await admitted
    if (typeof verdict === "string" || run.cancelled) {
      if (runs.get(roomId) === run) runs.delete(roomId)
      if (typeof verdict !== "string") return undefined
      write(roomId, (current) => ({ ...current, note: verdict, noteKind: "problem" }))
      return verdict
    }
    const seats = verdict.seats
    const byId = new Map(seats.map((seat) => [seat.member.id, seat]))
    const perRoundUsd = room.spend?.perRoundUsd
    const going = runRoom(
      room.name,
      seats.map((seat) => seat.member),
      {
        log: () => roomOf(roomId)?.log ?? EMPTY_LOG,
        setLog: (log) =>
          write(roomId, (current) => {
            const last = log.entries[log.entries.length - 1]
            const fresh = last && last.from.kind === "bot" && !current.log.entries.some((entry) => entry.id === last.id)
            return { ...current, log, needsYou: current.needsYou || Boolean(fresh && needsYou(last.text)) }
          }),
        speak: async (member, prompt, leftUsd) => {
          const seat = byId.get(member.id)
          if (!seat) return { text: null, costUsd: 0 }
          const turn = deps.turns.room(seat.bot, prompt, roomThread(roomId, seat.bot.path), seat.cwd, memberBudget(seat.pay, leftUsd))
          // The bot is busy elsewhere, in its chat or another room: it keeps silent here.
          if (!turn) return { text: null, costUsd: 0 }
          run.speaking = seat.bot
          try {
            const result = await turn.result
            return { text: result.status === "done" ? takeMemoryOps(result.text).text : null, costUsd: result.costUsd }
          } finally {
            run.speaking = undefined
          }
        },
        cancelled: () => run.cancelled,
        onTurn: (member) => deps.onTurn?.(roomId, member ? byId.get(member.id)?.bot.path : undefined),
        now,
        newId,
        ...(perRoundUsd !== undefined ? { perRoundUsd } : {}),
      },
    )
    run.done = going
    try {
      const { end } = await going
      const note = endNote(end, perRoundUsd)
      if (note) write(roomId, (current) => ({ ...current, note, noteKind: "end" }))
    } finally {
      if (runs.get(roomId) === run) runs.delete(roomId)
    }
    return undefined
  }

  /* The checks before any turn: the room's size, each member's trust, and the spend. */
  const admit = async (room: RoomRecord): Promise<string | { seats: readonly RoomSeat[] }> => {
    const size = roomProblem(room.members)
    if (size) return describeProblem(size)
    const seats = await deps.seats(room)
    if ("problem" in seats) return seats.problem
    const spend = roomSpendProblem(
      seats.map((seat) => ({ name: seat.member.name, pay: seat.pay })),
      room.spend,
      deps.testBuild(),
    )
    if (spend) return spend
    return { seats }
  }

  return { send, stop, running: (roomId) => runs.has(roomId) }
}
