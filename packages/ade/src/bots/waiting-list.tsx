import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { t } from "../i18n"
import { sourcesText } from "./approval-signal"
import { decideApproval, remainingClock, type ApprovalChoice, type WaitingApproval } from "./approvals"

/**
 * «Aspettano te»: what the bots wait for, at the top of the list of bots (the user's choice 4). Each one says whose
 * bot, what it wants, where it asked (ADE or a chat), how long is left, and has Consenti and Nega there: the answer is
 * the same as on the bot's own card, and for a question that came from a phone it is the phone's answer. «Sempre» is
 * not here: a standing yes is given on the bot's own page, where it is seen and can be taken back.
 */
export function WaitingList(props: {
  waiting: () => readonly WaitingApproval[]
  /** The bot's page, or the room when the question was asked in one. */
  onOpen: (bot: string, room?: string) => void
  /** Absent, `decideApproval`: the answer goes to every member of the request. */
  onDecide?: (waiting: WaitingApproval, choice: ApprovalChoice) => void
  /** Absent, the clock; a test passes its own. */
  now?: () => number
}) {
  const [tick, setTick] = createSignal(Date.now())
  const now = () => props.now?.() ?? tick()

  // The seconds left count down while something waits, and only then.
  createEffect(() => {
    if (props.now || props.waiting().length === 0) return
    setTick(Date.now())
    const timer = setInterval(() => setTick(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  const decide = (waiting: WaitingApproval, choice: ApprovalChoice) =>
    props.onDecide ? props.onDecide(waiting, choice) : void decideApproval(waiting, choice)

  return (
    <Show when={props.waiting().length > 0}>
      <section data-slot="bots-waiting" aria-label={t("bots.waiting.title")}>
        <h3 data-slot="bots-waiting-title">{t("bots.waiting.title")}</h3>
        <ul data-slot="bots-waiting-list">
          <For each={props.waiting()}>
            {(waiting) => (
              <li data-slot="bots-waiting-item">
                <button type="button" data-slot="bots-link" onClick={() => props.onOpen(waiting.bot, waiting.room)}>
                  {waiting.botName}
                </button>
                <span data-slot="bots-waiting-what" title={`${waiting.permission} ${waiting.patterns}`}>
                  {t("bots.waiting.what", waiting.permission, waiting.patterns.trim() || "?")}
                </span>
                <Show when={waiting.reason}>{(reason) => <span data-slot="bots-hint">{reason()}</span>}</Show>
                <span data-slot="bots-hint">
                  {sourcesText(waiting.sources)} · {t("bots.waiting.left", remainingClock(waiting, now()))}
                </span>
                <span data-slot="bots-waiting-actions">
                  <Show when={waiting.choices.includes("once")}>
                    <button type="button" data-slot="bots-btn" onClick={() => decide(waiting, "once")}>
                      {t("bots.permission.allow")}
                    </button>
                  </Show>
                  <Show when={waiting.choices.includes("reject")}>
                    <button type="button" data-slot="bots-btn" data-tone="danger" onClick={() => decide(waiting, "reject")}>
                      {t("bots.permission.deny")}
                    </button>
                  </Show>
                </span>
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  )
}
