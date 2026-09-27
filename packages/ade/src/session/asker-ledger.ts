/**
 * Which pane asked, as ADE remembers it (notifiche-design review, BASSO 1).
 *
 * `fromPane` sends an answer to a pane's terminal. `ade-msg registro` writes
 * it from the sender's verified token, but the register is a plain file: a
 * line written into it by hand could name any pane. So ADE keeps its own
 * record of the questions it wrote, in the webview's storage where no agent
 * reaches, and a line's `fromPane` counts only when that record says the same.
 * Anything else loses the pane and goes to «Risposte a», as before the field.
 */

export interface AskerStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface AskerLedger {
  /** ADE wrote question `k` of register `path` at `at` for pane `pane`. */
  remember(path: string, k: string, at: string, pane: string): void
  /** The events of `path`, with `fromPane` and `agent` kept only where ADE wrote them. */
  vouch<E extends { readonly k: string; readonly at: string; readonly fromPane?: string; readonly agent?: string }>(
    path: string,
    events: readonly E[],
  ): E[]
}

export const ASKER_LEDGER_KEY = "ade.register.askers"
/** The newest questions kept; an older one still answers, to «Risposte a». */
export const ASKER_LEDGER_CAP = 500

const entryId = (path: string, k: string, at: string) => `${path}\n${k}\n${at}`

export function askerLedger(store: () => AskerStore | undefined, cap = ASKER_LEDGER_CAP): AskerLedger {
  const read = (): [string, string][] => {
    try {
      const parsed: unknown = JSON.parse(store()?.getItem(ASKER_LEDGER_KEY) ?? "[]")
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (entry): entry is [string, string] =>
          Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string",
      )
    } catch {
      return []
    }
  }

  return {
    remember: (path, k, at, pane) => {
      const id = entryId(path, k, at)
      const entries = read().filter(([known]) => known !== id)
      entries.push([id, pane])
      try {
        store()?.setItem(ASKER_LEDGER_KEY, JSON.stringify(entries.slice(-cap)))
      } catch {
        // No storage: the answer goes to «Risposte a», as it would without the field.
      }
    },
    vouch: (path, events) => {
      if (!events.some((event) => event.fromPane || event.agent)) return [...events]
      const known = new Map(read())
      return events.map((event) => {
        if (!event.fromPane && !event.agent) return event
        if (event.fromPane && known.get(entryId(path, event.k, event.at)) === event.fromPane) return event
        const { fromPane: _pane, agent: _agent, ...rest } = event
        return rest as unknown as typeof event
      })
    },
  }
}
