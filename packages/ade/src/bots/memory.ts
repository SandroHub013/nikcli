/**
 * A bot's memory (B8a): two blocks it keeps across conversations, its own
 * notes and what it knows of the user, each within a limit in characters.
 *
 * How it reaches the bot: a snapshot of both blocks opens the first message
 * of a conversation (`memoryPreface`), and stays as it was for the whole of
 * it: the conversation is resumed (`--resume`, a session id), never sent
 * again, so what the bot writes meanwhile shows from the next conversation.
 *
 * How the bot writes it: the runner is a CLI ADE does not own, so there is
 * no tool of ours inside it. The bot writes a tag in its answer instead —
 * `<ade-memory op="add" block="notes">…</ade-memory>` — which works the same
 * on nikcli, Claude Code and Codex, and needs no shell (a routine and a chat
 * have none). ADE takes the tags out of the answer when the turn ends and
 * applies them (`takeMemoryOps`, `applyMemoryOps`).
 *
 * The rules: past the limit is an error, never a silent cut; the same entry
 * twice is not added; an entry that holds a key (`terms.ts`) or a memory tag
 * is refused. What failed is said in the thread, and to the bot at the start
 * of its next turn, so it can make room.
 */

import { t } from "../i18n"
import { scrubSecrets, SECRET_MARK } from "./terms"

export type MemoryBlock = "notes" | "user"

export const MEMORY_BLOCKS: readonly MemoryBlock[] = ["notes", "user"]

/** In characters, entries and separators counted. */
export const MEMORY_LIMITS: Readonly<Record<MemoryBlock, number>> = { notes: 2200, user: 1375 }

/** Between two entries, in the count and in the snapshot. */
export const ENTRY_SEPARATOR = "\n§\n"

export interface BotMemory {
  readonly notes: readonly string[]
  readonly user: readonly string[]
  /** What the bot's last writes came to, for the start of its next turn. */
  readonly pending?: readonly string[]
}

export const EMPTY_MEMORY: BotMemory = { notes: [], user: [] }

export type MemoryOp =
  | { readonly op: "add"; readonly block: MemoryBlock; readonly text: string }
  | { readonly op: "replace"; readonly block: MemoryBlock; readonly match: string; readonly text: string }
  | { readonly op: "remove"; readonly block: MemoryBlock; readonly match: string }

export type MemoryResult =
  | { readonly ok: true; readonly memory: BotMemory; readonly message: string }
  | { readonly ok: false; readonly memory: BotMemory; readonly error: string }

/** The characters a block takes. */
export function memorySize(entries: readonly string[]): number {
  return entries.join(ENTRY_SEPARATOR).length
}

const TAG = /<\/?ade-memory\b/i

/** Why `text` cannot be an entry; undefined when it can. */
export function entryProblem(text: string): string | undefined {
  if (text.trim().length === 0) return t("bots.memory.error.empty")
  // A key, or one the thread already hid (B4): either way, not for the memory.
  if (scrubSecrets(text) !== text || text.includes(SECRET_MARK)) return t("bots.memory.error.secret")
  if (TAG.test(text)) return t("bots.memory.error.tag")
  if (text.includes(ENTRY_SEPARATOR.trim())) return t("bots.memory.error.separator")
  return undefined
}

/** Two entries that say the same thing: case and spacing aside. */
const same = (a: string, b: string) =>
  a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase()

const blockName = (block: MemoryBlock) => t(block === "notes" ? "bots.memory.notes" : "bots.memory.user")

function over(block: MemoryBlock, entries: readonly string[], memory: BotMemory): MemoryResult | undefined {
  const size = memorySize(entries)
  const limit = MEMORY_LIMITS[block]
  if (size <= limit) return undefined
  return { ok: false, memory, error: t("bots.memory.error.full", blockName(block), size, limit) }
}

/** The one entry `match` points at, or why there is none. */
function pick(block: MemoryBlock, entries: readonly string[], match: string): number | string {
  const wanted = match.trim()
  if (wanted.length === 0) return t("bots.memory.error.noMatch", blockName(block), match)
  const found = entries.map((entry, at) => ({ entry, at })).filter(({ entry }) => entry.includes(wanted))
  if (found.length === 0) return t("bots.memory.error.noMatch", blockName(block), wanted)
  if (new Set(found.map(({ entry }) => entry)).size > 1)
    return t("bots.memory.error.manyMatches", blockName(block), wanted)
  return found[0]!.at
}

const withBlock = (memory: BotMemory, block: MemoryBlock, entries: readonly string[]): BotMemory => ({
  ...memory,
  [block]: entries,
})

/** One write: an error leaves the memory as it was. */
export function applyMemoryOp(memory: BotMemory, op: MemoryOp): MemoryResult {
  const entries = memory[op.block]
  if (op.op === "remove") {
    const at = pick(op.block, entries, op.match)
    if (typeof at === "string") return { ok: false, memory, error: at }
    return {
      ok: true,
      memory: withBlock(
        memory,
        op.block,
        entries.filter((_, index) => index !== at),
      ),
      message: t("bots.memory.done.remove", blockName(op.block)),
    }
  }
  const text = op.text.trim()
  const problem = entryProblem(text)
  if (problem) return { ok: false, memory, error: problem }
  if (op.op === "add") {
    if (entries.some((entry) => same(entry, text)))
      return { ok: false, memory, error: t("bots.memory.error.duplicate", blockName(op.block)) }
    const next = [...entries, text]
    return (
      over(op.block, next, memory) ?? {
        ok: true,
        memory: withBlock(memory, op.block, next),
        message: t("bots.memory.done.add", blockName(op.block)),
      }
    )
  }
  const at = pick(op.block, entries, op.match)
  if (typeof at === "string") return { ok: false, memory, error: at }
  if (entries.some((entry, index) => index !== at && same(entry, text))) {
    return { ok: false, memory, error: t("bots.memory.error.duplicate", blockName(op.block)) }
  }
  const next = entries.map((entry, index) => (index === at ? text : entry))
  return (
    over(op.block, next, memory) ?? {
      ok: true,
      memory: withBlock(memory, op.block, next),
      message: t("bots.memory.done.replace", blockName(op.block)),
    }
  )
}

/** Each write in turn; the ones that fail are skipped, and said. */
export function applyMemoryOps(
  memory: BotMemory,
  ops: readonly MemoryOp[],
): { memory: BotMemory; results: MemoryResult[] } {
  let current = memory
  const results: MemoryResult[] = []
  for (const op of ops) {
    const result = applyMemoryOp(current, op)
    results.push(result)
    current = result.memory
  }
  return { memory: current, results }
}

/* ── the tags in an answer ────────────────────────────────────────────── */

const OP_TAG = /<ade-memory\b([^>]*?)(?:\/>|>([\s\S]*?)<\/ade-memory\s*>)/gi
const ATTRIBUTE = /(\w+)\s*=\s*"([^"]*)"/g

const unescape = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")

function readOp(attributes: string, body: string): MemoryOp | undefined {
  const found: Record<string, string> = {}
  for (const [, name, value] of attributes.matchAll(ATTRIBUTE)) found[name!.toLowerCase()] = unescape(value!)
  const block = found["block"]
  if (block !== "notes" && block !== "user") return undefined
  const text = body.trim()
  switch (found["op"]) {
    case "add":
      return { op: "add", block, text }
    case "replace":
      return found["match"] === undefined ? undefined : { op: "replace", block, match: found["match"], text }
    case "remove":
      return found["match"] === undefined ? undefined : { op: "remove", block, match: found["match"] }
    default:
      return undefined
  }
}

/**
 * The writes in `text`, in order, and the text without them. A tag ADE
 * cannot read is taken out too and counted, so it never reaches the user
 * as if it were an answer.
 */
export function takeMemoryOps(text: string): { text: string; ops: MemoryOp[]; unreadable: number } {
  const ops: MemoryOp[] = []
  let unreadable = 0
  const rest = text.replace(OP_TAG, (_whole, attributes: string, body: string | undefined) => {
    const op = readOp(attributes, body ?? "")
    if (op) ops.push(op)
    else unreadable++
    return ""
  })
  if (ops.length === 0 && unreadable === 0) return { text, ops, unreadable }
  return { text: rest.replace(/\n{3,}/g, "\n\n").trim(), ops, unreadable }
}

/* ── what the bot is told ─────────────────────────────────────────────── */

function renderBlock(block: MemoryBlock, entries: readonly string[]): string {
  const size = memorySize(entries)
  const limit = MEMORY_LIMITS[block]
  const title = t(block === "notes" ? "bots.memory.prompt.notes" : "bots.memory.prompt.user", size, limit)
  return `== ${title} ==\n${entries.length > 0 ? entries.join(ENTRY_SEPARATOR) : t("bots.memory.prompt.empty")}`
}

/** Both blocks as they are now, with how to change them. */
export function memorySnapshot(memory: BotMemory): string {
  return [
    t("bots.memory.prompt.head"),
    renderBlock("notes", memory.notes),
    renderBlock("user", memory.user),
    t("bots.memory.prompt.howTo"),
    '<ade-memory op="add" block="notes">…</ade-memory>',
    '<ade-memory op="replace" block="user" match="…">…</ade-memory>',
    '<ade-memory op="remove" block="notes" match="…"></ade-memory>',
    t("bots.memory.prompt.rules", MEMORY_LIMITS.notes, MEMORY_LIMITS.user),
    t("bots.memory.prompt.end"),
  ].join("\n")
}

/**
 * What goes before the user's words in the message sent: the snapshot, only
 * when the conversation starts, and what the bot's last writes came to.
 */
export function memoryPreface(memory: BotMemory, conversationStarts: boolean): string {
  const parts: string[] = []
  if (conversationStarts) parts.push(memorySnapshot(memory))
  if (memory.pending && memory.pending.length > 0)
    parts.push(t("bots.memory.prompt.pending", memory.pending.join("\n")))
  return parts.join("\n\n")
}

/* ── where it is kept ─────────────────────────────────────────────────── */

export interface MemoryStore {
  get: (bot: string) => BotMemory
  set: (bot: string, memory: BotMemory) => void
}

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : []

/** What was saved, as far as it can be trusted: a block over its limit is not read at all. */
export function parseMemory(value: unknown): BotMemory {
  if (!value || typeof value !== "object" || Array.isArray(value)) return EMPTY_MEMORY
  const record = value as Record<string, unknown>
  const block = (name: MemoryBlock) => {
    const entries = strings(record[name])
    return memorySize(entries) <= MEMORY_LIMITS[name] ? entries : []
  }
  const pending = strings(record["pending"]).slice(-10)
  return { notes: block("notes"), user: block("user"), ...(pending.length > 0 ? { pending } : {}) }
}

const STORAGE_KEY = "ade.bots.memory"

function readMap(raw: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw ?? "{}") as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** In the WebView's storage, by the bot file's path, like its account. */
export function localMemoryStore(key: string = STORAGE_KEY): MemoryStore {
  const fallback = new Map<string, BotMemory>()
  return {
    get: (bot) => {
      try {
        return parseMemory(readMap(localStorage.getItem(key))[bot])
      } catch {
        return fallback.get(bot) ?? EMPTY_MEMORY
      }
    },
    set: (bot, memory) => {
      fallback.set(bot, memory)
      try {
        const all = readMap(localStorage.getItem(key))
        all[bot] = parseMemory(memory)
        localStorage.setItem(key, JSON.stringify(all))
      } catch {
        // Storage blocked: the memory lasts until ADE closes.
      }
    },
  }
}

export function volatileMemoryStore(): MemoryStore {
  const saved = new Map<string, BotMemory>()
  return {
    get: (bot) => saved.get(bot) ?? EMPTY_MEMORY,
    set: (bot, memory) => void saved.set(bot, parseMemory(memory)),
  }
}
