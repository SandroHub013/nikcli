import { createSignal } from "solid-js"
import { againEvent, answerEvent, reopenEvent, sheetAnswerEvent, togglePick } from "./answer"
import { t } from "../i18n"
import { runSubmit, submitControl, submitSteps } from "./card"
// The same rule for both registers, written once (audit 0.7.7, MEDIO 7).
import { waitsForRecipient } from "../decisions/card"
import type { DeliveryCandidate, DeliveryState, RecipientStatus } from "./delivery"
import { recipientFor } from "./delivery"
import type { AnsweredDesignEvent, DesignVariant } from "./log"
import type { DesignRegister } from "./register"
import type { DesignProposal } from "./state"

export interface DesignDraft {
  /** One variant, or the boxes ticked on a `multi` proposal. */
  readonly picked?: number | readonly number[]
  readonly note: string
}

export function projectRootFromRegisterPath(registerPath: string | undefined): string | undefined {
  if (!registerPath) return undefined
  return registerPath.replace(/[\\/]\.ade[\\/]design\.jsonl$/i, "")
}

export interface DesignHub {
  readonly register: DesignRegister
  projectRoot?: () => string | undefined
  recipient: () => RecipientStatus
  /** Who receives this one: the pane that asked while it runs, else the chosen session. */
  recipientFor: (proposal: DesignProposal) => RecipientStatus
  sessions: () => readonly DeliveryCandidate[]
  choose: (id: string | undefined) => void
  delivery: (proposal: DesignProposal) => DeliveryState
  draft: (k: string) => DesignDraft
  setDraft: (k: string, draft: DesignDraft) => void
  /**
   * Picks variant `index` (from 0), or ticks its box on a `multi` proposal:
   * the card, the sheet and «Scelgo questa» in the browser pane (D2) all go
   * through here, so the three cannot pick differently.
   */
  pick: (proposal: Pick<DesignProposal, "k" | "multi">, index: number) => void
  /**
   * Whether the pick of `k` was made in this window, through `pick`: the
   * sheet keeps it when it opens, and Enter may send it. A pick the sheet
   * finds without this mark is cleared (D2 review, MEDIO).
   */
  chosen: (k: string) => boolean
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
   * «Altro giro»: records the note as a request for another round. It goes
   * where the main button goes: with nobody to receive it and no running
   * session picked inline it records nothing, like «Scegli e invia»; with one
   * picked, that session is chosen first.
   */
  again: (proposal: DesignProposal) => Promise<boolean>
  /** «Ho scelto sul foglio»: the choice was made on the claude.ai page; the answer says to read it there. */
  sheetChosen: (proposal: DesignProposal) => Promise<boolean>
  reopen: (proposal: DesignProposal) => Promise<boolean>
}

export function createDesignHub(deps: {
  register: DesignRegister
  projectRoot?: () => string | undefined
  recipient: () => RecipientStatus
  sessions: () => readonly DeliveryCandidate[]
  choose: (id: string | undefined) => void
  delivery: (proposal: DesignProposal) => DeliveryState
  onAnswered: (proposal: DesignProposal, event: AnsweredDesignEvent) => void
  onReopened?: (proposal: DesignProposal, deliveredTo?: string, deliveredToId?: string) => void
}): DesignHub {
  const [drafts, setDrafts] = createSignal<Record<string, DesignDraft>>({})
  const [chosenKeys, setChosenKeys] = createSignal<ReadonlySet<string>>(new Set())
  const [busyKeys, setBusyKeys] = createSignal<ReadonlySet<string>>(new Set())
  const [problems, setProblems] = createSignal<Record<string, string | undefined>>({})
  const [inline, setInline] = createSignal<string>()

  const setProblem = (k: string, text: string | undefined) => setProblems((all) => ({ ...all, [k]: text }))
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
  const setDraft = (k: string, value: DesignDraft) => {
    setDrafts((all) => ({ ...all, [k]: value }))
    if (problems()[k]) setProblem(k, undefined)
  }
  const clearDraft = (k: string) => {
    setDrafts((all) => {
      const next = { ...all }
      delete next[k]
      return next
    })
    setChosenKeys((keys) => {
      const next = new Set(keys)
      next.delete(k)
      return next
    })
  }

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
    recipientFor: (proposal) => recipientFor(proposal.raisedFrom, deps.sessions(), deps.recipient()),
    sessions: deps.sessions,
    choose: deps.choose,
    delivery: deps.delivery,
    draft,
    setDraft,
    pick: (proposal, index) => {
      const current = draft(proposal.k)
      setDraft(proposal.k, { ...current, picked: togglePick(current.picked, index, Boolean(proposal.multi)) })
      setChosenKeys((keys) => new Set(keys).add(proposal.k))
    },
    chosen: (k) => chosenKeys().has(k),
    busy: (k) => busyKeys().has(k),
    problem: (k) => problems()[k],
    answer,
    inlineRecipient: inline,
    setInlineRecipient: (id) => {
      setInline(id)
      // A session picked: the note asking for one is done with.
      setProblems((all) =>
        Object.fromEntries(Object.entries(all).filter(([, text]) => text !== t("design.sheet.needRecipient"))),
      )
    },
    submit: (proposal, press) => {
      const control = submitControl({
        recipient: recipientFor(proposal.raisedFrom, deps.sessions(), deps.recipient()),
        sessions: deps.sessions(),
        inline: inline(),
        busy: busyKeys().has(proposal.k),
        label: "",
      })
      if (waitsForRecipient(control, deps.sessions(), inline(), press)) {
        setProblem(proposal.k, t("design.sheet.needRecipient"))
        return Promise.resolve(false)
      }
      const steps = submitSteps(control, deps.sessions(), inline(), press)
      return runSubmit(steps, {
        choose: (id) => {
          deps.choose(id)
          setInline(undefined)
        },
        answer: () => answer(proposal),
      })
    },
    sheetChosen: (proposal) => record(proposal, sheetAnswerEvent(proposal, draft(proposal.k).note, new Date())),
    again: (proposal) => {
      const event = againEvent(proposal, draft(proposal.k).note, new Date())
      if (typeof event === "string") return record(proposal, event)
      const control = submitControl({
        recipient: recipientFor(proposal.raisedFrom, deps.sessions(), deps.recipient()),
        sessions: deps.sessions(),
        inline: inline(),
        busy: busyKeys().has(proposal.k),
        label: "",
      })
      const steps = submitSteps(control, deps.sessions(), inline(), "primary")
      // Nobody would read it: not a silent write to the outbox (S75 point 1).
      if (steps.length === 0) return Promise.resolve(false)
      const chosen = steps.find((step) => step.kind === "choose")
      if (chosen?.kind === "choose") {
        deps.choose(chosen.id)
        setInline(undefined)
      }
      return record(proposal, event)
    },
    reopen: (proposal) =>
      write(proposal.k, async () => {
        const delivery = deps.delivery(proposal)
        const wasDelivered = delivery.state === "consegnata"
        const deliveredTo = wasDelivered ? delivery.to : undefined
        const deliveredToId = wasDelivered && delivery.state === "consegnata" ? delivery.toId : undefined
        await deps.register.append(reopenEvent(proposal.k, new Date()))
        if (wasDelivered) {
          deps.onReopened?.(proposal, deliveredTo, deliveredToId)
        }
      }),
  }
}
