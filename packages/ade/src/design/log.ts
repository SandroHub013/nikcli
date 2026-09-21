import { t } from "../i18n"

/**
 * The design proposals register, as it is written to disk in `.ade/design.jsonl`.
 *
 * One JSON object per line, appended and never rewritten: an event says what
 * happened to a design proposal — aperta, risposta, chiusa — and the current
 * state is computed from all of them by `state.ts`.
 *
 * A proposal carries a key, title, author, reference spec, short text/context,
 * and one or more variants, each with a name, a two-line description, and a
 * preview (an image path/URL or a standalone HTML page).
 */

export const DESIGN_EVENT_TYPES = ["aperta", "risposta", "chiusa"] as const

export type DesignEventType = (typeof DESIGN_EVENT_TYPES)[number]

export interface DesignVariant {
  /** Variant name or label, e.g. "A · Rail a gruppi" */
  readonly name: string
  /** Two-line description of the direction */
  readonly description: string
  /** Disk path or URL to an image or standalone HTML page */
  readonly preview: string
}

interface EventBase {
  /** The proposal's key, stable for its whole life: `DS1`, `S54-settings`. */
  readonly k: string
  /** ISO timestamp of when it happened. */
  readonly at: string
  /** Who wrote it: a session title, "fable", "utente", "Master". */
  readonly by: string
}

export interface OpenedDesignEvent extends EventBase {
  readonly type: "aperta"
  readonly title: string
  /** What the user needs to know, in plain words. */
  readonly context?: string
  /** Reference spec, e.g. "S54" or "S57". */
  readonly spec?: string
  /** One or more design variants to pick from. */
  readonly variants: readonly DesignVariant[]
  /** Lower comes first. Absent: after ordered ones, by time. */
  readonly order?: number
}

export interface AnsweredDesignEvent extends EventBase {
  readonly type: "risposta"
  /** The variant name chosen, when one was. */
  readonly choice?: string
  /** A note added to the choice. */
  readonly note?: string
  /** What the user decided, verbatim. Required: it is what gets executed. */
  readonly words: string
}

export interface ClosedDesignEvent extends EventBase {
  readonly type: "chiusa"
  /** Evidence of completion: commit, screenshot, branch, etc. */
  readonly evidence?: string
}

export type DesignEvent = OpenedDesignEvent | AnsweredDesignEvent | ClosedDesignEvent

export interface LogProblem {
  readonly line: number
  readonly reason: string
}

export interface ParsedLog {
  readonly events: readonly DesignEvent[]
  readonly problems: readonly LogProblem[]
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/

export function isDesignKey(text: string): boolean {
  return KEY.test(text)
}

export function parseDesignLog(text: string): ParsedLog {
  const events: DesignEvent[] = []
  const problems: LogProblem[] = []
  const lines = text.split(/\r?\n/)
  lines.forEach((raw, index) => {
    const line = raw.trim()
    if (line.length === 0) return
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      problems.push({ line: index + 1, reason: t("design.log.json") })
      return
    }
    const checked = toEvent(value)
    if (typeof checked === "string") problems.push({ line: index + 1, reason: checked })
    else events.push(checked)
  })
  return { events, problems }
}

export function serializeDesignEvent(event: DesignEvent): string {
  const checked = toEvent(event)
  if (typeof checked === "string") throw new Error(t("design.log.invalid", checked))
  return `${JSON.stringify(checked)}\n`
}

export function toEvent(value: unknown): DesignEvent | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return t("design.log.notObject")
  const record = value as Record<string, unknown>
  const type = record.type
  if (typeof type !== "string" || !DESIGN_EVENT_TYPES.includes(type as DesignEventType)) return t("design.log.type")
  const k = text(record.k)
  if (!k || !isDesignKey(k)) return t("design.log.key")
  const at = text(record.at)
  if (!at || Number.isNaN(Date.parse(at))) return t("design.log.date")
  const by = text(record.by)
  if (!by) return t("design.log.author")
  const base = { k, at, by }

  switch (type as DesignEventType) {
    case "aperta": {
      const title = text(record.title)
      if (!title) return t("design.log.title")
      const variants = variantsOf(record.variants)
      if (typeof variants === "string") return variants
      if (variants.length === 0) return t("design.log.variants")
      const order = record.order
      if (order !== undefined && (typeof order !== "number" || !Number.isFinite(order))) return t("design.log.order")
      return compact({
        type: "aperta",
        ...base,
        title,
        context: text(record.context),
        spec: text(record.spec),
        variants,
        order: order as number | undefined,
      }) as OpenedDesignEvent
    }
    case "risposta": {
      const words = text(record.words)
      if (!words) return t("design.log.words")
      return compact({
        type: "risposta",
        ...base,
        words,
        choice: text(record.choice),
        note: text(record.note),
      }) as AnsweredDesignEvent
    }
    case "chiusa":
      return compact({
        type: "chiusa",
        ...base,
        evidence: text(record.evidence),
      }) as ClosedDesignEvent
  }
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function variantsOf(value: unknown): DesignVariant[] | string {
  if (!Array.isArray(value)) return t("design.log.variants")
  const variants: DesignVariant[] = []
  for (const item of value) {
    if (!item || typeof item !== "object") return t("design.log.variants")
    const rec = item as Record<string, unknown>
    const name = text(rec.name)
    if (!name) return t("design.log.variantName")
    const description = text(rec.description) ?? ""
    const preview = text(rec.preview) ?? ""
    variants.push({ name, description, preview })
  }
  return variants
}

function compact<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T
}
