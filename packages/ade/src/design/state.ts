import { asOneLine } from "../session/typing"
import type { DesignEvent, DesignVariant, LogProblem } from "./log"
import { t } from "../i18n"

export type DesignStatus = "aperta" | "risposta" | "chiusa"

export interface DesignAnswer {
  readonly choice?: string
  readonly note?: string
  readonly words: string
  readonly at: string
  readonly by: string
}

export interface DesignProposal {
  readonly k: string
  readonly title: string
  readonly context?: string
  readonly spec?: string
  readonly variants: readonly DesignVariant[]
  readonly order?: number
  readonly raisedBy: string
  readonly openedAt: string
  readonly status: DesignStatus
  readonly answer?: DesignAnswer
  readonly closedAt?: string
  readonly evidence?: string
  readonly history: readonly DesignEvent[]
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

export function foldProposals(events: readonly DesignEvent[]): DesignState {
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
        context: event.context,
        spec: event.spec,
        variants: event.variants,
        order: event.order,
        raisedBy: event.by,
        openedAt: event.at,
        status: "aperta",
        history: [event],
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
        if (current.status === "risposta") {
          reject(event, t("design.rule.answered", event.k))
          continue
        }
        current.answer = {
          choice: event.choice,
          note: event.note,
          words: event.words,
          at: event.at,
          by: event.by,
        }
        current.status = "risposta"
        break
      case "chiusa":
        current.status = "chiusa"
        current.closedAt = event.at
        current.evidence = event.evidence
        break
    }
    current.history = [...current.history, event]
  }

  const proposals = [...byKey.values()]
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
  readonly closed: readonly DesignProposal[]
}

export function bucketProposals(proposals: readonly DesignProposal[]): DesignBuckets {
  const sorted = [...proposals].sort(compareProposals)
  return {
    forYou: sorted.filter((d) => d.status === "aperta"),
    answered: sorted.filter((d) => d.status === "risposta"),
    closed: sorted.filter((d) => d.status === "chiusa"),
  }
}

export function resolvedMessage(proposal: DesignProposal): string {
  const answer = proposal.answer
  if (!answer) throw new Error(`${proposal.k} non ha una risposta`)
  const parts = [`design [k=${proposal.k}] ${proposal.title}`]
  if (answer.choice) parts.push(`scelta: ${answer.choice}`)
  if (answer.note) parts.push(`nota: ${answer.note}`)
  parts.push(`parole: "${answer.words}"`)
  if (proposal.spec) parts.push(`spec: ${proposal.spec}`)
  return asOneLine(parts.join(" — "))
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
