import { createSignal, type Accessor } from "solid-js"
import { answerEvent } from "./answer"
import type { DeliveryCandidate, DeliveryState, RecipientStatus } from "./delivery"
import type { AnsweredDesignEvent, DesignVariant } from "./log"
import type { DesignRegister } from "./register"
import type { DesignProposal } from "./state"

export interface DesignDraft {
  readonly picked?: number
  readonly note: string
}

export interface FullPreviewState {
  readonly open: boolean
  readonly variant?: DesignVariant
  readonly title?: string
}

export interface DesignHub {
  readonly register: DesignRegister
  recipient: () => RecipientStatus
  sessions: () => readonly DeliveryCandidate[]
  choose: (id: string | undefined) => void
  delivery: (proposal: DesignProposal) => DeliveryState
  draft: (k: string) => DesignDraft
  setDraft: (k: string, draft: DesignDraft) => void
  busy: (k: string) => boolean
  problem: (k: string) => string | undefined
  answer: (proposal: DesignProposal) => Promise<boolean>
  fullPreview: Accessor<FullPreviewState>
  openFullPreview: (variant: DesignVariant, title?: string) => void
  closeFullPreview: () => void
}

export function createDesignHub(deps: {
  register: DesignRegister
  recipient: () => RecipientStatus
  sessions: () => readonly DeliveryCandidate[]
  choose: (id: string | undefined) => void
  delivery: (proposal: DesignProposal) => DeliveryState
  onAnswered: (proposal: DesignProposal, event: AnsweredDesignEvent) => void
}): DesignHub {
  const [drafts, setDrafts] = createSignal<Record<string, DesignDraft>>({})
  const [busyKeys, setBusyKeys] = createSignal<ReadonlySet<string>>(new Set())
  const [problems, setProblems] = createSignal<Record<string, string | undefined>>({})
  const [fullPreview, setFullPreview] = createSignal<FullPreviewState>({ open: false })

  const setProblem = (k: string, text: string | undefined) =>
    setProblems((all) => ({ ...all, [k]: text }))
  const setBusy = (k: string, on: boolean) =>
    setBusyKeys((keys) => {
      const next = new Set(keys)
      if (on) next.add(k)
      else next.delete(k)
      return next
    })

  const write = async (k: string, run: () => Promise<void>): Promise<boolean> => {
    if (busyKeys().has(k)) return false
    setBusy(k, true)
    setProblem(k, undefined)
    try {
      await run()
      return true
    } catch (failure) {
      setProblem(k, failure instanceof Error ? failure.message : String(failure))
      return false
    } finally {
      setBusy(k, false)
    }
  }

  const draft = (k: string): DesignDraft => drafts()[k] ?? { note: "" }
  const clearDraft = (k: string) =>
    setDrafts((all) => {
      const next = { ...all }
      delete next[k]
      return next
    })

  return {
    register: deps.register,
    recipient: deps.recipient,
    sessions: deps.sessions,
    choose: deps.choose,
    delivery: deps.delivery,
    draft,
    setDraft: (k, value) => {
      setDrafts((all) => ({ ...all, [k]: value }))
      if (problems()[k]) setProblem(k, undefined)
    },
    busy: (k) => busyKeys().has(k),
    problem: (k) => problems()[k],
    answer: (proposal) => {
      const current = draft(proposal.k)
      const event = answerEvent(proposal, current.picked, current.note, new Date())
      if (typeof event === "string") {
        setProblem(proposal.k, event)
        return Promise.resolve(false)
      }
      return write(proposal.k, async () => {
        await deps.register.append(event)
        clearDraft(proposal.k)
        deps.onAnswered(proposal, event)
      })
    },
    fullPreview,
    openFullPreview: (variant, title) => setFullPreview({ open: true, variant, title }),
    closeFullPreview: () => setFullPreview({ open: false }),
  }
}
