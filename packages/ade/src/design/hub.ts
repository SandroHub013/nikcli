import { createSignal, type Accessor } from "solid-js"
import { againEvent, answerEvent } from "./answer"
import { runSubmit, submitControl, submitSteps } from "./card"
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

export function projectRootFromRegisterPath(registerPath: string | undefined): string | undefined {
  if (!registerPath) return undefined
  return registerPath.replace(/[\\/]\.ade[\\/]design\.jsonl$/i, "")
}

export interface DesignHub {
  readonly register: DesignRegister
  projectRoot?: () => string | undefined
  recipient: () => RecipientStatus
  sessions: () => readonly DeliveryCandidate[]
  choose: (id: string | undefined) => void
  delivery: (proposal: DesignProposal) => DeliveryState
  draft: (k: string) => DesignDraft
  setDraft: (k: string, draft: DesignDraft) => void
  busy: (k: string) => boolean
  problem: (k: string) => string | undefined
  answer: (proposal: DesignProposal) => Promise<boolean>
  /** The session picked in a card's own "who receives" select, not yet chosen. */
  inlineRecipient: () => string | undefined
  setInlineRecipient: (id: string | undefined) => void
  /**
   * The card's buttons and Enter: `primary` sends, first choosing the session
   * picked inline when nobody receives yet; `record` writes without sending.
   */
  submit: (proposal: DesignProposal, press: "primary" | "record") => Promise<boolean>
  /**
   * «Altro giro»: records the note as a request for another round. Like the
   * main button, a session picked inline is chosen first.
   */
  again: (proposal: DesignProposal) => Promise<boolean>
  fullPreview: Accessor<FullPreviewState>
  openFullPreview: (variant: DesignVariant, title?: string) => void
  closeFullPreview: () => void
}

export function createDesignHub(deps: {
  register: DesignRegister
  projectRoot?: () => string | undefined
  recipient: () => RecipientStatus
  sessions: () => readonly DeliveryCandidate[]
  choose: (id: string | undefined) => void
  delivery: (proposal: DesignProposal) => DeliveryState
  onAnswered: (proposal: DesignProposal, event: AnsweredDesignEvent) => void
}): DesignHub {
  const [drafts, setDrafts] = createSignal<Record<string, DesignDraft>>({})
  const [busyKeys, setBusyKeys] = createSignal<ReadonlySet<string>>(new Set())
  const [problems, setProblems] = createSignal<Record<string, string | undefined>>({})
  const [inline, setInline] = createSignal<string>()
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

  const record = (proposal: DesignProposal, event: AnsweredDesignEvent | string): Promise<boolean> => {
    if (typeof event === "string") {
      setProblem(proposal.k, event)
      return Promise.resolve(false)
    }
    return write(proposal.k, async () => {
      await deps.register.append(event)
      clearDraft(proposal.k)
      deps.onAnswered(proposal, event)
    })
  }

  const answer = (proposal: DesignProposal): Promise<boolean> => {
    const current = draft(proposal.k)
    return record(proposal, answerEvent(proposal, current.picked, current.note, new Date()))
  }

  return {
    register: deps.register,
    projectRoot: deps.projectRoot,
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
    answer,
    inlineRecipient: inline,
    setInlineRecipient: setInline,
    submit: (proposal, press) => {
      const control = submitControl({
        recipient: deps.recipient(),
        sessions: deps.sessions(),
        inline: inline(),
        busy: busyKeys().has(proposal.k),
        label: "",
      })
      const steps = submitSteps(control, deps.sessions(), inline(), press)
      return runSubmit(steps, {
        choose: (id) => {
          deps.choose(id)
          setInline(undefined)
        },
        answer: () => answer(proposal),
      })
    },
    again: (proposal) => {
      const event = againEvent(proposal, draft(proposal.k).note, new Date())
      if (typeof event === "string") return record(proposal, event)
      const control = submitControl({
        recipient: deps.recipient(),
        sessions: deps.sessions(),
        inline: inline(),
        busy: busyKeys().has(proposal.k),
        label: "",
      })
      const chosen = submitSteps(control, deps.sessions(), inline(), "primary").find((step) => step.kind === "choose")
      if (chosen?.kind === "choose") {
        deps.choose(chosen.id)
        setInline(undefined)
      }
      return record(proposal, event)
    },
    fullPreview,
    openFullPreview: (variant, title) => setFullPreview({ open: true, variant, title }),
    closeFullPreview: () => setFullPreview({ open: false }),
  }
}
