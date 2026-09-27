import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js"
import { Sheet, SheetTitle } from "../ui/sheet"
import { enterReady, sheetKey } from "./answer"
import { isFormField } from "../decisions/answer"
import { submitControl } from "./card"
import { DesignCard } from "./design-card"
import { openExternally } from "../browser/host-bridge"
import { answeredStatus, type RecipientStatus } from "./delivery"
import { afterAnswer, askerName } from "../choices/list"
import { projectRootFromRegisterPath, type DesignHub } from "./hub"
import { bucketProposals, type DesignProposal } from "./state"
import "./design.css"
import { t } from "../i18n"

export function DesignSheet(props: {
  hub: DesignHub
  onClose: () => void
  onOpenPanel: () => void
  /** The key to open at: the entry picked in «Da scegliere». */
  start?: string
  /** How many entries wait in «Da scegliere», this sheet's included. */
  waiting?: () => number
  /** After the last answer here: back to «Da scegliere», or closed (`afterAnswer`). */
  onDone?: (next: "list" | "close", said?: string) => void
}) {
  const root = () => props.hub.projectRoot?.() ?? projectRootFromRegisterPath(props.hub.register.path())
  const buckets = createMemo(() => bucketProposals(props.hub.register.state()?.proposals ?? []))
  const open = () => buckets().forYou
  const queued = () =>
    [...buckets().answered, ...buckets().rework].filter((proposal) => props.hub.delivery(proposal).state === "in coda")
      .length
  const [index, setIndex] = createSignal(
    Math.max(0, props.start ? open().findIndex((item) => item.k === props.start) : 0),
  )
  const at = () => Math.min(index(), Math.max(0, open().length - 1))
  const current = () => open()[at()]
  let surface: HTMLDivElement | undefined
  let note: HTMLTextAreaElement | undefined

  const [needChoice, setNeedChoice] = createSignal<string>()

  const pick = (k: string, index: number, multi: boolean) => {
    props.hub.pick({ k, ...(multi ? { multi: true as const } : {}) }, index)
    setNeedChoice(undefined)
  }

  /*
   * A pick found here that nobody made in this window is cleared, so a plain
   * Enter never sends a choice the user has not seen made. One made through
   * `hub.pick` — the card, or «Scelgo questa» in the browser pane — stays
   * (D2 review, MEDIO: «I pick in the pane, send from the sheet» lost it).
   */
  onMount(() => {
    for (const proposal of open()) {
      const draft = props.hub.draft(proposal.k)
      if (draft.picked !== undefined && !props.hub.chosen(proposal.k))
        props.hub.setDraft(proposal.k, { ...draft, picked: undefined })
    }
    surface?.focus()
  })

  const [statusMessage, setStatusMessage] = createSignal<string>()
  // An answer given here: the sheet empty after it is done, not «none open».
  const [answered, setAnswered] = createSignal(false)
  createEffect(() => {
    if (!answered()) return
    const next = afterAnswer(open().length, props.waiting?.() ?? 0)
    // What the footer said goes with the sheet: the caller shows it as a toast (rifiniture 2).
    if (next !== "stay") props.onDone?.(next, untrack(statusMessage))
  })
  let statusTimer: ReturnType<typeof setTimeout> | undefined

  onCleanup(() => {
    if (statusTimer) clearTimeout(statusTimer)
  })

  const showStatus = (text: string) => {
    if (statusTimer) clearTimeout(statusTimer)
    setStatusMessage(text)
    statusTimer = setTimeout(() => {
      setStatusMessage(undefined)
      statusTimer = undefined
    }, 4000)
  }

  const submit = async (press: "primary" | "record" = "primary") => {
    const proposal = current()
    if (!proposal) return
    const draft = props.hub.draft(proposal.k)
    const label = designChoiceLabel(proposal, draft.picked, draft.note)
    if (await props.hub.submit(proposal, press)) {
      // The answer's own session, the pane that asked when it runs; not «Risposte a».
      showStatus(answeredStatus(proposal.k, label, props.hub.recipientFor(proposal)))
      setAnswered(true)
      surface?.focus()
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    const proposal = current()
    const draft = proposal ? props.hub.draft(proposal.k) : undefined
    const picked = Boolean(
      proposal && draft && enterReady(Boolean(proposal.multi), draft.picked, draft.note, props.hub.chosen(proposal.k)),
    )
    const inText = event.target === note
    const action = sheetKey(event, proposal?.variants.length ?? 0, inText, picked, !inText && isFormField(event.target))
    if (!action) return
    event.preventDefault()
    event.stopPropagation()
    if (action.kind === "close") props.onClose()
    else if (!proposal) return
    else if (action.kind === "pick") pick(proposal.k, action.index, Boolean(proposal.multi))
    else if (action.kind === "need-choice") setNeedChoice(proposal.k)
    else if (action.kind === "submit") void submit()
    else if (action.kind === "next") setIndex(Math.min(at() + 1, open().length - 1))
    else if (action.kind === "previous") setIndex(Math.max(at() - 1, 0))
  }

  return (
    <Sheet
      component="design-sheet"
      onClose={props.onClose}
      // The one sheet of a proposal: every variant at its own size, one under the other or side by side.
      size="xl"
      ref={(element) => (surface = element)}
      onKeyDown={onKeyDown}
    >
      <header data-slot="sheet-head">
        <SheetTitle as="strong">{t("palette.design.open")}</SheetTitle>
        <Show when={open().length > 0}>
          <span data-slot="sheet-count">{t("design.sheet.position", at() + 1, open().length)}</span>
          <span data-slot="sheet-steps" aria-hidden="true">
            <For each={open()}>{(_, i) => <i data-on={i() === at() ? "true" : undefined} />}</For>
          </span>
        </Show>
        <button type="button" data-slot="sheet-close" onClick={() => props.onClose()} aria-label={t("new.close")}>
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <path
              d="M2.5 2.5l7 7M9.5 2.5l-7 7"
              fill="none"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </header>

      <div data-slot="sheet-body">
        <Show when={props.hub.register.error()}>
          <div data-slot="design-problem" role="alert">
            {t("design.unreadable", String(props.hub.register.error()))}
          </div>
        </Show>
        <Show
          when={current()?.k}
          keyed
          fallback={
            <div data-slot="sheet-empty">
              <b>{t("design.none")}</b>
              <span>{t("design.sheet.empty")}</span>
            </div>
          }
        >
          {(k) => {
            const proposal = () => current()!
            return (
              <DesignCard
                proposal={proposal()}
                picked={props.hub.draft(k).picked}
                note={props.hub.draft(k).note}
                busy={props.hub.busy(k)}
                problem={props.hub.problem(k) ?? (needChoice() === k ? t("design.sheet.needChoice") : undefined)}
                control={submitControl({
                  recipient: props.hub.recipientFor(proposal()),
                  sessions: props.hub.sessions(),
                  inline: props.hub.inlineRecipient(),
                  busy: props.hub.busy(k),
                  label: open().length > 1 ? t("design.submitNext") : t("design.submit"),
                })}
                onInline={(id) => props.hub.setInlineRecipient(id)}
                onRecord={() => void submit("record")}
                onAgain={() => void props.hub.again(proposal()).then((done) => done && surface?.focus())}
                recipientHint={recipientHint(props.hub.recipientFor(proposal()))}
                askedBy={askerName(proposal(), props.hub.sessions())}
                now={new Date()}
                projectRoot={root()}
                onPick={(index) => pick(k, index, Boolean(proposal().multi))}
                onNote={(text) => props.hub.setDraft(k, { ...props.hub.draft(k), note: text })}
                onSubmit={() => void submit()}
                onChoose={(index) => {
                  // One press: picked and sent; on a question of several, ticked.
                  pick(k, index, Boolean(proposal().multi))
                  if (!proposal().multi) void submit()
                }}
                onOpenUrl={() => void openExternally(proposal().url!)}
                onSheetChosen={() =>
                  void props.hub.sheetChosen(proposal()).then((done) => {
                    if (done)
                      showStatus(
                        answeredStatus(proposal().k, t("design.url.words"), props.hub.recipientFor(proposal())),
                      )
                    if (done) setAnswered(true)
                    if (done) surface?.focus()
                  })
                }
                noteRef={(element) => (note = element)}
              />
            )
          }}
        </Show>
      </div>

      <footer data-slot="sheet-foot">
        <span>{t("design.sheet.keys")}</span>
        <Show when={statusMessage()}>
          <span data-slot="sheet-status" role="status" aria-live="polite">
            {statusMessage()}
          </span>
        </Show>
        <Show when={props.hub.recipient().state !== "pronta" && queued() > 0}>
          <span data-tone="warn">
            {t(
              props.hub.recipient().state === "non scelta" ? "design.sheet.queued.none" : "design.sheet.queued.idle",
              queued(),
            )}
          </span>
        </Show>
        <button type="button" data-slot="design-ghost" onClick={() => props.onOpenPanel()}>
          {t("design.sheet.full")}
        </button>
      </footer>
    </Sheet>
  )
}

export function designChoiceLabel(
  proposal: DesignProposal,
  picked: number | readonly number[] | undefined,
  note: string,
): string {
  if (proposal.multi) {
    const boxes = Array.isArray(picked) ? picked : picked !== undefined ? [picked as number] : []
    const choices = proposal.variants.filter((_, index) => boxes.includes(index)).map((v) => v.name)
    return choices.join(" + ") || note.trim()
  }
  const index = Array.isArray(picked) ? picked[0] : picked
  const choice = index !== undefined ? proposal.variants[index]?.name : undefined
  return choice ?? note.trim()
}

export function recipientHint(recipient: RecipientStatus): string {
  if (recipient.state === "pronta") return t("design.hint.ready", recipient.title)
  if (recipient.state === "non attiva") return t("design.hint.idle", recipient.title)
  return t("design.hint.none")
}
