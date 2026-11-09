/**
 * Which of the user's answers ADE wrote itself (SEC-3).
 *
 * A register line that says `"by":"utente"` is only a line of a plain file. An agent that records what the user said in
 * chat writes it by hand, with no malice at all, and the panel then told the user they had answered a decision they had
 * never seen, while `design attendi` printed that choice as theirs. So ADE keeps its own record of the answers its
 * buttons wrote, in the webview's storage where no agent reaches (as `asker-ledger` does for `fromPane`), and a line of
 * the user's that is not in it is shown as reported by the register.
 *
 * Each ADE vouches only for its own clicks: an answer given in another ADE (ADE Test on the same project) or before this
 * record existed shows as reported, and nothing is lost by it.
 */

export interface AnswerStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** The word shown where the user's name would be: «riportata da registro». */
export const UNVOUCHED_BY = "registro"

/** The word the registers use for the user's own events (`decisions/answer`'s USER). */
const USER_BY = "utente"

export const ANSWER_LEDGER_KEY = "ade.register.answers"
/** The newest answers kept; an older one shows as reported. */
export const ANSWER_LEDGER_CAP = 2000
/** The most the record weighs, in characters. An entry holds a whole answer, and the record shares its storage with the mail. */
export const ANSWER_LEDGER_BUDGET = 500_000

/** What the record asks of a register event. */
export interface LedgerEvent {
  readonly type: string
  readonly k: string
  readonly at: string
  readonly choice?: string
  readonly choices?: readonly string[]
  readonly note?: string
  readonly words?: string
  readonly again?: true
  readonly until?: string
}

/**
 * An event by its kind and what it says, and not only its time: the time of a true event is in the file for anyone to copy,
 * and a session could add under it an answer of its own (review of sicurezza-due, N1). Whole and not hashed: `vouch` is
 * synchronous, as WebCrypto is not, and an entry the size of one answer is no burden under `ANSWER_LEDGER_CAP`.
 * Compared with the line as the parser gives it back: `toEvent` trims and tidies, and the registers remember its result.
 */
const entryPrefix = (path: string, k: string, type: string, at: string) => `${path}\n${k}\n${type}\n${at}\n`
const entryId = (path: string, event: LedgerEvent) =>
  entryPrefix(path, event.k, event.type, event.at) +
  JSON.stringify([event.choice, event.choices, event.note, event.words, event.again, event.until].map((field) => field ?? null))
/** An answer known only from the outbox, which holds no content. Never written for one this record already has. */
const seededId = (path: string, k: string, at: string) => entryPrefix(path, k, "risposta", at)
const vouchedBy = (known: ReadonlySet<string>, path: string, event: LedgerEvent) =>
  known.has(entryId(path, event)) || (event.type === "risposta" && known.has(seededId(path, event.k, event.at)))

export interface AnswerLedger {
  /** ADE's own button wrote this event in register `path`. */
  remember(path: string, event: LedgerEvent): void
  /** Whether ADE wrote that event. */
  has(path: string, event: LedgerEvent): boolean
  /** Answers ADE gave that still stand (the outbox), put in the record once at load. */
  seed(items: readonly { readonly path: string; readonly k: string; readonly answeredAt: string; readonly kind?: string }[]): void
  /** The events of `path`, with `by: "utente"` kept only where ADE wrote the event. */
  vouch<E extends LedgerEvent & { readonly by: string; readonly fromPane?: string }>(
    path: string,
    events: readonly E[],
  ): E[]
}

export function answerLedger(
  store: () => AnswerStore | undefined,
  cap = ANSWER_LEDGER_CAP,
  budget = ANSWER_LEDGER_BUDGET,
): AnswerLedger {
  const read = (): string[] => {
    try {
      const parsed: unknown = JSON.parse(store()?.getItem(ANSWER_LEDGER_KEY) ?? "[]")
      return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []
    } catch {
      return []
    }
  }

  const write = (entries: string[]) => {
    try {
      const kept = entries.slice(-cap)
      let size = JSON.stringify(kept).length
      let first = 0
      while (size > budget && first < kept.length - 1) size -= JSON.stringify(kept[first++]).length + 1
      store()?.setItem(ANSWER_LEDGER_KEY, JSON.stringify(kept.slice(first)))
    } catch {
      // No storage: the answer shows as reported by the register, which loses nothing.
    }
  }

  return {
    remember: (path, event) => {
      const id = entryId(path, event)
      write([...read().filter((known) => known !== id), id])
    },
    has: (path, event) => vouchedBy(new Set(read()), path, event),
    seed: (items) => {
      if (items.length === 0) return
      const known = read()
      const added = items
        .filter((item) => item.kind !== "riaperta")
        .map((item) => seededId(item.path, item.k, item.answeredAt))
        .filter((id) => !known.some((entry) => entry.startsWith(id)))
      if (added.length > 0) write([...known, ...added])
    },
    vouch: (path, events) => {
      if (!events.some((event) => event.by === USER_BY && !event.fromPane)) return [...events]
      const known = new Set(read())
      return events.map((event) =>
        event.by === USER_BY && !event.fromPane && !vouchedBy(known, path, event)
          ? { ...event, by: UNVOUCHED_BY }
          : event,
      )
    },
  }
}
