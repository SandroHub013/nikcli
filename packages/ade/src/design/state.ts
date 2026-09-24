import { asOneLine } from "../session/typing"
import type { DesignEvent, DesignRecommendation, DesignVariant, LogProblem } from "./log"
import { t } from "../i18n"

/** `giro`: the user asked for another round; it waits for a `riaperta` with new variants. */
export type DesignStatus = "aperta" | "risposta" | "giro" | "chiusa"

export interface DesignAnswer {
  readonly choice?: string
  readonly choices?: readonly string[]
  readonly note?: string
  readonly words: string
  readonly at: string
  readonly by: string
  /** Another round asked for, not a choice. */
  readonly again?: true
}

export interface DesignProposal {
  readonly k: string
  readonly title: string
  /** The question, in one line; the title stays for the list. */
  readonly question?: string
  /** Why it is being decided now, in a sentence or two. */
  readonly why?: string
  readonly context?: string
  /** The variant the writer recommends, and why. */
  readonly recommend?: DesignRecommendation
  readonly spec?: string
  /** What stays as it is, whichever variant is picked. */
  readonly keeps?: readonly string[]
  readonly variants: readonly DesignVariant[]
  /** More than one variant may be picked. */
  readonly multi?: true
  readonly order?: number
  readonly raisedBy: string
  readonly openedAt: string
  readonly status: DesignStatus
  readonly answer?: DesignAnswer
  readonly closedAt?: string
  readonly evidence?: string
  readonly history: readonly DesignEvent[]
  /** Which round of variants this is: 1 when opened, one more at each `riaperta`. */
  readonly round?: number
}

export interface RejectedEvent {
  readonly event: DesignEvent
  readonly reason: string
}

export interface DesignState {
  readonly proposals: readonly DesignProposal[]
  readonly rejected: readonly RejectedEvent[]
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

function isProposalUnchanged(prev: DesignProposal, next: DesignProposal): boolean {
  if (prev.status !== next.status) return false
  if (prev.round !== next.round) return false
  if (prev.closedAt !== next.closedAt) return false
  if (prev.evidence !== next.evidence) return false
  if (prev.history.length !== next.history.length) return false
  for (let i = 0; i < prev.history.length; i++) {
    const pe = prev.history[i]
    const ne = next.history[i]
    if (pe === ne) continue
    if (pe.type !== ne.type || pe.at !== ne.at || pe.by !== ne.by) return false
    if (JSON.stringify(pe) !== JSON.stringify(ne)) return false
  }
  return true
}

export function foldProposals(
  events: readonly DesignEvent[],
  prev?: DesignState | Map<string, DesignProposal>,
): DesignState {
  const prevByKey = prev instanceof Map ? prev : prev ? new Map(prev.proposals.map((p) => [p.k, p])) : undefined
  const byKey = new Map<string, Mutable<DesignProposal>>()
  const rejected: RejectedEvent[] = []
  const reject = (event: DesignEvent, reason: string) => rejected.push({ event, reason })

  for (const event of events) {
    const current = byKey.get(event.k)

    if (event.type === "aperta") {
      if (current) {
        reject(event, t("design.rule.exists", event.k))
        continue
      }
      byKey.set(event.k, {
        k: event.k,
        title: event.title,
        ...(event.question ? { question: event.question } : {}),
        ...(event.why ? { why: event.why } : {}),
        context: event.context,
        ...(event.recommend ? { recommend: event.recommend } : {}),
        spec: event.spec,
        ...(event.keeps && event.keeps.length > 0 ? { keeps: event.keeps } : {}),
        variants: event.variants,
        ...(event.multi ? { multi: true as const } : {}),
        order: event.order,
        raisedBy: event.by,
        openedAt: event.at,
        status: "aperta",
        history: [event],
        round: 1,
      })
      continue
    }

    if (!current) {
      reject(event, t("design.rule.neverOpened", event.k))
      continue
    }

    if (current.status === "chiusa") {
      reject(event, t("design.rule.closed", event.k))
      continue
    }

    switch (event.type) {
      case "risposta":
        // A new answer after "altro giro" needs the new round first.
        if (current.status === "risposta" || current.status === "giro") {
          reject(event, t("design.rule.answered", event.k))
          continue
        }
        {
          // The log does not know how the proposal was opened: the fold does.
          const wrong = choiceProblem(current, event.choice, event.choices, current.variants.map((variant) => variant.name))
          if (wrong) {
            reject(event, t(wrong, event.k))
            continue
          }
        }
        current.answer = {
          choice: event.choice,
          ...(event.choices ? { choices: event.choices } : {}),
          note: event.note,
          words: event.words,
          at: event.at,
          by: event.by,
          ...(event.again ? { again: true as const } : {}),
        }
        current.status = event.again ? "giro" : "risposta"
        break
      case "riaperta":
        if (current.status === "aperta") {
          reject(event, t("design.rule.open", event.k))
          continue
        }
        current.status = "aperta"
        current.answer = undefined
        if (event.variants) current.variants = event.variants
        current.round = (current.round ?? 1) + 1
        break
      case "chiusa":
        current.status = "chiusa"
        current.closedAt = event.at
        current.evidence = event.evidence
        break
    }
    current.history = [...current.history, event]
  }

  const proposals: DesignProposal[] = []
  for (const proposal of byKey.values()) {
    const prevProposal = prevByKey?.get(proposal.k)
    if (prevProposal && isProposalUnchanged(prevProposal, proposal)) {
      proposals.push(prevProposal)
    } else {
      proposals.push(proposal)
    }
  }
  return { proposals, rejected }
}

export function compareProposals(a: DesignProposal, b: DesignProposal): number {
  const ao = a.order ?? Number.POSITIVE_INFINITY
  const bo = b.order ?? Number.POSITIVE_INFINITY
  if (ao !== bo) return ao < bo ? -1 : 1
  return Date.parse(a.openedAt) - Date.parse(b.openedAt)
}

export interface DesignBuckets {
  readonly forYou: readonly DesignProposal[]
  readonly answered: readonly DesignProposal[]
  /** Another round asked for: the author owes new variants. */
  readonly rework: readonly DesignProposal[]
  readonly closed: readonly DesignProposal[]
}

export function bucketProposals(proposals: readonly DesignProposal[]): DesignBuckets {
  const sorted = [...proposals].sort(compareProposals)
  return {
    forYou: sorted.filter((d) => d.status === "aperta"),
    answered: sorted.filter((d) => d.status === "risposta"),
    rework: sorted.filter((d) => d.status === "giro"),
    closed: sorted.filter((d) => d.status === "chiusa"),
  }
}

export function resolvedMessage(proposal: DesignProposal): string {
  const answer = proposal.answer
  if (!answer) throw new Error(`${proposal.k} non ha una risposta`)
  const parts = [`design [k=${proposal.k}] ${proposal.title}`]
  if (answer.again) {
    // Work for the author, not a choice to carry out.
    parts.push("ALTRO GIRO, non una scelta", `parole: "${answer.words}"`, "rifai le varianti e riapri con: ade-msg registro design riaperta")
    return asOneLine(parts.join(" — "))
  }
  if (answer.choices) parts.push(`scelte: ${answer.choices.join(" + ")}`)
  else if (answer.choice) parts.push(`scelta: ${answer.choice}`)
  if (answer.note) parts.push(`nota: ${answer.note}`)
  parts.push(`parole: "${answer.words}"`)
  if (proposal.spec) parts.push(`spec: ${proposal.spec}`)
  return asOneLine(parts.join(" — "))
}

/**
 * Why an answer does not fit how the proposal was opened, as an i18n key:
 * a multiple proposal takes `choices` from its own variants, never `choice`;
 * a single one never takes `choices`.
 */
function choiceProblem(
  proposal: { multi?: true },
  choice: string | undefined,
  choices: readonly string[] | undefined,
  known: readonly string[],
): "design.rule.multiChoice" | "design.rule.unknownChoice" | "design.rule.singleChoice" | undefined {
  if (proposal.multi) {
    if (choice !== undefined) return "design.rule.multiChoice"
    if (choices?.some((item) => !known.includes(item))) return "design.rule.unknownChoice"
    return undefined
  }
  return choices ? "design.rule.singleChoice" : undefined
}

export function nextDesignKey(proposals: readonly Pick<DesignProposal, "k">[], prefix = "DS"): string {
  let highest = 0
  for (const { k } of proposals) {
    const match = new RegExp(`^${prefix}(\\d+)$`).exec(k)
    if (match) highest = Math.max(highest, Number(match[1]))
  }
  return `${prefix}${highest + 1}`
}

export function describeProblems(problems: readonly LogProblem[], rejected: readonly RejectedEvent[]): string[] {
  return [
    ...problems.map((problem) => t("design.problem.line", problem.line, problem.reason)),
    ...rejected.map((item) => `${item.event.type} ${item.event.k}: ${item.reason}`),
  ]
}
