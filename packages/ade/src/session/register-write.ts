/**
 * `ade-msg registro`: the one writer of the Decisions and Design registers.
 *
 * A line written by hand that the parser throws away is listed only inside
 * the full panel, and nobody opens it when no button shows: that is how D66–
 * D76 vanished. Here the sender gives the event's fields as JSON, and ADE
 * adds `type`, `at` and `by`, checks the line with the register's own
 * serializer and fold, appends it, reads the file back and says whether the
 * key is now where it should be. Any step that fails answers `errore: …` and,
 * before the append, writes nothing.
 *
 * Plain `.ts` with its I/O passed in, so every refusal is tested.
 */

import { parseDecisionLog, serializeDecisionEvent, type DecisionEvent } from "../decisions/log"
import { bucketDecisions, describeProblems as describeDecisionProblems, foldDecisions, nextDecisionKey } from "../decisions/state"
import { parseDesignLog, serializeDesignEvent, type DesignEvent } from "../design/log"
import { bucketProposals, describeProblems as describeDesignProblems, foldProposals, nextDesignKey } from "../design/state"
import type { RegisterName } from "./mailbox"

export interface RegisterWriteDeps {
  /** The register file as it is now; "" when it does not exist yet. */
  read: () => Promise<string>
  /** Appends to the file; a string is the failure. */
  append: (text: string) => Promise<string | null | undefined | void>
  now: () => Date
  /** The sender pane's title: the event's `by`. */
  sender: string
}

export interface RegisterMessage {
  readonly register: RegisterName
  readonly op: string
  /** The event's fields as JSON, without `type`, `at` and `by`. */
  readonly text: string
}

/** Steps 2–9 of S75 point 5; the project was found by the caller (step 1). */
export async function registerWrite(deps: RegisterWriteDeps, message: RegisterMessage): Promise<string> {
  let fields: unknown
  try {
    fields = JSON.parse(message.text)
  } catch (error) {
    return `errore: il json non si legge: ${error instanceof Error ? error.message : String(error)}`
  }
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return "errore: il json non è un oggetto"
  const record: Record<string, unknown> = { ...(fields as Record<string, unknown>) }
  // ADE says when and who: whatever the JSON says about it is ignored.
  delete record.at
  delete record.by
  delete record.type

  const before = await readText(deps)
  if (typeof before !== "string") return before.error
  const book: Book = message.register === "design" ? design : decisions

  if (record.k === undefined && message.op === "aperta") record.k = book.nextKey(before, deps.now())
  if (typeof record.k !== "string" || !record.k.trim()) return "errore: manca la chiave k"

  const event = { ...record, type: message.op, at: deps.now().toISOString(), by: deps.sender }
  let line: string
  try {
    line = book.serialize(event)
  } catch (error) {
    return `errore: ${error instanceof Error ? error.message : String(error)}`
  }
  const parsed = JSON.parse(line) as { k: string; variants?: { preview?: string }[]; again?: boolean }
  const k = parsed.k

  if (message.register === "design" && (message.op === "aperta" || message.op === "riaperta")) {
    const twice = samePreview(parsed.variants ?? [])
    if (twice) return `errore: due varianti con la stessa anteprima (${twice}): una pagina per variante, vedi S75 punto 3`
  }

  const refused = book.refusal(before, JSON.parse(line), deps.now())
  if (refused) return `errore: ${refused}`

  const joiner = before.length > 0 && !before.endsWith("\n") ? "\n" : ""
  let failure: string | null | undefined | void
  try {
    failure = await deps.append(`${joiner}${line}`)
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }
  if (failure) return `errore: ${failure}`

  const after = await readText(deps)
  const expected = expectedState(message.op, parsed.again === true)
  if (typeof after !== "string") return `errore: scritta ma non risulta ${expected.word}: ${after.error.replace(/^errore: /, "")}`
  if (!book.holds(after, k, expected.test, deps.now())) {
    const problems = book.problems(after, deps.now())
    return `errore: scritta ma non risulta ${expected.word}: ${problems.length > 0 ? problems.join("; ") : "la riga non è nel file"}`
  }
  /*
   * The key's state says what the register holds, not whose event put it
   * there: two answers written a moment apart both find the key answered, and
   * the one the fold refused was told «ok» (audit 0.7.7, MEDIO 5). So the
   * event is looked for by its own `at` and `by`, and must be one the fold kept.
   */
  const own = book.own(after, { k, type: message.op, at: event.at, by: event.by }, deps.now())
  if (own !== true) return `errore: scritta ma non conta: ${own}`
  return `ok: ${k} ${expected.word}, nel tasto ${message.register === "design" ? "Design" : "Decisioni"} entro 3 s`
}

async function readText(deps: RegisterWriteDeps): Promise<string | { error: string }> {
  try {
    return await deps.read()
  } catch (error) {
    return { error: `errore: il registro non si legge: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** The preview two variants share, if any. Empty previews are not a page. */
function samePreview(variants: readonly { preview?: string }[]): string | undefined {
  const seen = new Set<string>()
  for (const variant of variants) {
    const preview = variant.preview?.trim()
    if (!preview) continue
    if (seen.has(preview)) return preview
    seen.add(preview)
  }
  return undefined
}

type Where = "forYou" | "risposta" | "giro" | "rimandata" | "chiusa"

function expectedState(op: string, again: boolean): { word: string; test: Where } {
  if (op === "aperta" || op === "riaperta") return { word: "aperta", test: "forYou" }
  if (op === "risposta") return again ? { word: "giro", test: "giro" } : { word: "risposta", test: "risposta" }
  if (op === "rimandata") return { word: "rimandata", test: "rimandata" }
  return { word: "chiusa", test: "chiusa" }
}

/** What the writer needs of a register: the same functions the panel uses. */
interface Book {
  nextKey: (text: string, now: Date) => string
  serialize: (event: unknown) => string
  refusal: (text: string, event: unknown, now: Date) => string | undefined
  holds: (text: string, k: string, where: Where, now: Date) => boolean
  problems: (text: string, now: Date) => string[]
  /** True when this very event is in the file and the fold kept it; otherwise why not. */
  own: (text: string, event: OwnEvent, now: Date) => true | string
}

interface OwnEvent {
  readonly k: string
  readonly type: string
  readonly at: string
  readonly by: string
}

/** Finds `event` among `events` by key, type, time and author, and says whether the fold refused it. */
function ownVerdict<E extends { k?: unknown; type?: unknown; at?: unknown; by?: unknown }>(
  events: readonly E[],
  rejected: readonly { event: unknown; reason: string }[],
  event: OwnEvent,
): true | string {
  const found = events.find((item) => item.k === event.k && item.type === event.type && item.at === event.at && item.by === event.by)
  if (!found) return "la riga non è nel file"
  return rejected.find((item) => item.event === found)?.reason ?? true
}

const decisions: Book = {
  nextKey: (text, now) => nextDecisionKey(foldDecisions(parseDecisionLog(text).events, now).decisions),
  serialize: (event) => serializeDecisionEvent(event as DecisionEvent),
  refusal: (text, event, now) => {
    const fresh = event as DecisionEvent
    const folded = foldDecisions([...parseDecisionLog(text).events, fresh], now)
    return folded.rejected.find((item) => item.event === fresh)?.reason
  },
  holds: (text, k, where, now) => {
    const state = foldDecisions(parseDecisionLog(text).events, now)
    if (where === "forYou") return bucketDecisions(state.decisions).forYou.some((item) => item.k === k)
    return state.decisions.some((item) => item.k === k && item.status === where)
  },
  problems: (text, now) => {
    const parsed = parseDecisionLog(text)
    return describeDecisionProblems(parsed.problems, foldDecisions(parsed.events, now).rejected)
  },
  own: (text, event, now) => {
    const events = parseDecisionLog(text).events
    return ownVerdict(events, foldDecisions(events, now).rejected, event)
  },
}

const design: Book = {
  nextKey: (text) => nextDesignKey(foldProposals(parseDesignLog(text).events).proposals),
  serialize: (event) => serializeDesignEvent(event as DesignEvent),
  refusal: (text, event) => {
    const fresh = event as DesignEvent
    const folded = foldProposals([...parseDesignLog(text).events, fresh])
    return folded.rejected.find((item) => item.event === fresh)?.reason
  },
  holds: (text, k, where) => {
    const state = foldProposals(parseDesignLog(text).events)
    if (where === "forYou") return bucketProposals(state.proposals).forYou.some((item) => item.k === k)
    return state.proposals.some((item) => item.k === k && item.status === where)
  },
  problems: (text) => {
    const parsed = parseDesignLog(text)
    return describeDesignProblems(parsed.problems, foldProposals(parsed.events).rejected)
  },
  own: (text, event) => {
    const events = parseDesignLog(text).events
    return ownVerdict(events, foldProposals(events).rejected, event)
  },
}

/** Where a register event went: the project written, the one the bar shows, the one the sending session belongs to. */
export interface RegisterPlace {
  readonly written: string
  readonly shown?: string
  readonly asked?: string
}

/**
 * The reply, saying which project's register was written.
 *
 * The event goes to the register of the sender's project, and the Decisions
 * and Design buttons read the open project's: «nel tasto entro 3 s» was false
 * whenever the two differ. And a session whose project is not among the
 * recents fell back to the open one in silence (audit 0.7.7, MEDIO 4).
 */
export function withPlace(reply: string, register: RegisterName, place: RegisterPlace): string {
  if (!reply.startsWith("ok")) return reply
  const button = register === "design" ? "Design" : "Decisioni"
  let text =
    place.shown !== undefined && place.shown !== place.written
      ? `${reply.replace(`, nel tasto ${button} entro 3 s`, "")}, nel progetto ${place.written}: il tasto ${button} ora mostra ${place.shown}, lo vedi aprendo ${place.written}`
      : `${reply} (progetto ${place.written})`
  if (place.asked !== undefined && place.asked !== place.written) {
    text += `; la sessione è del progetto ${place.asked}, che non è fra i recenti: scritto in ${place.written}`
  }
  return text
}
