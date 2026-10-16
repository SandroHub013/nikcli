/**
 * The «unread» dot on a bot's row, and the bot's «Silenzia» (design/ade-bot-2, scelta 6).
 *
 * A bot has news when it wrote after the user last looked at its page: a reply, a routine that finished, a failure.
 * The row then has a dot and the name in bold, until the bot is opened. A muted bot never has the dot. A permission
 * request is not news of this kind: it has the bell, the badge of the Bot section and the system notification, and a
 * mute does not touch them (`approval-signal.ts`).
 *
 * Kept in ADE by the bot file's path, like the account choice, and taken away with the bot (`forget.ts`).
 */

import type { Talk } from "./talk"

export interface BotNotice {
  /** The last news the user saw on the bot's page. */
  readonly seenAt?: number
  readonly muted?: boolean
}

export interface NoticeBook {
  /**
   * When ADE first kept this book. What a bot wrote before it is read: on the first start with the dot no row lights
   * up for words the user had long seen.
   */
  readonly since: number
  readonly bots: Readonly<Record<string, BotNotice>>
}

export const NOTICE_STORAGE_KEY = "ade.bots.notice"

/** When the bot last wrote to the user: its last reply or failure, 0 for none. The user's words and tool lines are not news. */
export function lastNewsAt(talk: Pick<Talk, "messages">): number {
  for (let index = talk.messages.length - 1; index >= 0; index--) {
    const message = talk.messages[index]!
    if (message.role === "bot" || message.role === "error") return message.at
  }
  return 0
}

export function noticeOf(book: NoticeBook, bot: string): BotNotice {
  return book.bots[bot] ?? {}
}

export function unread(book: NoticeBook, bot: string, talk: Pick<Talk, "messages">): boolean {
  const notice = noticeOf(book, bot)
  if (notice.muted) return false
  return lastNewsAt(talk) > (notice.seenAt ?? book.since)
}

/** The user saw the bot's page with its news up to `at`; a look never goes back in time. The same book when nothing changes. */
export function seenUpTo(book: NoticeBook, bot: string, at: number): NoticeBook {
  const notice = noticeOf(book, bot)
  if (at <= (notice.seenAt ?? book.since)) return book
  return { ...book, bots: { ...book.bots, [bot]: { ...notice, seenAt: at } } }
}

export function muteBot(book: NoticeBook, bot: string, muted: boolean): NoticeBook {
  const { muted: _was, ...rest } = noticeOf(book, bot)
  return { ...book, bots: { ...book.bots, [bot]: muted ? { ...rest, muted: true } : rest } }
}

/** The bot is deleted: a new one at the same path starts with no mute and no look. */
export function forgetNotice(book: NoticeBook, bot: string): NoticeBook {
  if (!Object.hasOwn(book.bots, bot)) return book
  const { [bot]: _gone, ...kept } = book.bots
  return { ...book, bots: kept }
}

/** What was saved, as far as it can be trusted: a broken entry is dropped, never half-read. `now` starts a new book. */
export function parseNoticeBook(raw: string | null | undefined, now: number): NoticeBook {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw ?? "null")
  } catch {
    parsed = undefined
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { since: now, bots: {} }
  const record = parsed as Record<string, unknown>
  const since = typeof record["since"] === "number" && Number.isFinite(record["since"]) ? record["since"] : now
  const bots: Record<string, BotNotice> = {}
  const saved = record["bots"]
  if (saved && typeof saved === "object" && !Array.isArray(saved)) {
    for (const [path, value] of Object.entries(saved)) {
      const notice = parseNotice(value)
      if (notice) bots[path] = notice
    }
  }
  return { since, bots }
}

function parseNotice(value: unknown): BotNotice | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const seenAt = record["seenAt"]
  const muted = record["muted"]
  if (seenAt !== undefined && (typeof seenAt !== "number" || !Number.isFinite(seenAt))) return undefined
  if (muted !== undefined && muted !== true) return undefined
  return { ...(seenAt !== undefined ? { seenAt } : {}), ...(muted ? { muted: true } : {}) }
}

export interface NoticeStore {
  get: () => NoticeBook
  set: (book: NoticeBook) => void
}

export function localNoticeStore(key: string = NOTICE_STORAGE_KEY, now: () => number = Date.now): NoticeStore {
  const read = () => {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  }
  const write = (book: NoticeBook) => {
    try {
      localStorage.setItem(key, JSON.stringify(book))
    } catch {
      // Storage blocked: the dots and the mutes last until ADE closes.
    }
  }
  return {
    get: () => {
      const raw = read()
      const book = parseNoticeBook(raw, now())
      // The first start keeps its `since`, so the next one does not light up what came in between.
      if (raw === null) write(book)
      return book
    },
    set: write,
  }
}
