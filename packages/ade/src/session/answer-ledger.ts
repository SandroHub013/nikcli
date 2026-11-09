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

const entryId = (path: string, k: string, at: string) => `${path}\n${k}\n${at}`

export interface AnswerLedger {
  /** ADE's own button wrote an event for `k` of register `path` at `at`. */
  remember(path: string, k: string, at: string): void
  /** Whether ADE wrote that event. */
  has(path: string, k: string, at: string): boolean
  /** Answers ADE gave that still stand (the outbox), put in the record once at load. */
  seed(items: readonly { readonly path: string; readonly k: string; readonly answeredAt: string }[]): void
  /** The events of `path`, with `by: "utente"` kept only where ADE wrote the event. */
  vouch<E extends { readonly k: string; readonly at: string; readonly by: string; readonly fromPane?: string }>(
    path: string,
    events: readonly E[],
  ): E[]
}

export function answerLedger(store: () => AnswerStore | undefined, cap = ANSWER_LEDGER_CAP): AnswerLedger {
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
      store()?.setItem(ANSWER_LEDGER_KEY, JSON.stringify(entries.slice(-cap)))
    } catch {
      // No storage: the answer shows as reported by the register, which loses nothing.
    }
  }

  return {
    remember: (path, k, at) => {
      const id = entryId(path, k, at)
      write([...read().filter((known) => known !== id), id])
    },
    has: (path, k, at) => read().includes(entryId(path, k, at)),
    seed: (items) => {
      if (items.length === 0) return
      const known = new Set(read())
      const added = items.map((item) => entryId(item.path, item.k, item.answeredAt)).filter((id) => !known.has(id))
      if (added.length > 0) write([...read(), ...added])
    },
    vouch: (path, events) => {
      if (!events.some((event) => event.by === USER_BY && !event.fromPane)) return [...events]
      const known = new Set(read())
      return events.map((event) =>
        event.by === USER_BY && !event.fromPane && !known.has(entryId(path, event.k, event.at))
          ? { ...event, by: UNVOUCHED_BY }
          : event,
      )
    },
  }
}
