/**
 * The bot's money a day, as two pieces for the Impostazioni of its page (the user's choice 5): the cap's field and
 * the line «Spesa di oggi». Ready to be placed by the page with tabs; the logic is in `spend.ts`. Each draws nothing
 * for a bot that spends no money (a subscription, a free model), where no cap is asked.
 */

import { createSignal, Show } from "solid-js"
import { t } from "../i18n"
import type { BotAccount } from "./account"
import type { AgentFile } from "./ragu"
import { runnerById } from "./runners"
import { capText, parseCap, spendTerms, spendTodayLine, withCap, type SpendStore } from "./spend"
import { appSpendStore } from "./spend-app"

export interface SpendPieceProps {
  readonly bot: AgentFile
  /** The bot's account in ADE (`account.ts`). */
  readonly account: BotAccount
  /** The catalog's word on a ragu model (`catalog.ts`); absent, the `:free` suffix. */
  readonly free?: boolean | undefined
  /** Absent: the app's store, the one the turns count in. */
  readonly store?: SpendStore
  readonly now?: () => number
}

const termsOf = (props: SpendPieceProps) =>
  spendTerms(runnerById(props.bot.runner).id, props.account, props.bot.model, props.free)

/** «Spesa di oggi: 0,42 $ di 2,00 $», and that the bot is stopped once the cap is spent. */
export function SpendTodayLine(props: SpendPieceProps) {
  const line = () =>
    spendTodayLine((props.store ?? appSpendStore).get(props.bot.path), termsOf(props), (props.now ?? Date.now)())
  return <Show when={line()}>{(text) => <span data-slot="bots-hint">{text()}</span>}</Show>
}

/** The cap a day, in dollars: empty is no cap. Saved with the bot when the user presses the button. */
export function SpendCapField(props: SpendPieceProps) {
  const store = () => props.store ?? appSpendStore
  const [draft, setDraft] = createSignal<string>()
  const [problem, setProblem] = createSignal<string>()
  const [saved, setSaved] = createSignal(false)
  const shown = () => draft() ?? capText(store().get(props.bot.path).capUsd)

  const save = (event: SubmitEvent) => {
    event.preventDefault()
    const read = parseCap(shown())
    if (!read.ok) {
      setProblem(read.problem)
      return
    }
    setProblem(undefined)
    store().set(props.bot.path, withCap(store().get(props.bot.path), read.capUsd))
    setDraft(undefined)
    setSaved(true)
  }

  return (
    <Show when={termsOf(props) !== "none"}>
      <section data-slot="bots-card-section">
        <span data-slot="bots-label">{t("bots.daily.capLabel")}</span>
        <Show
          when={termsOf(props) === "money"}
          fallback={<span data-slot="bots-hint">{t("bots.daily.unreported")}</span>}
        >
          <form data-slot="gateway-row" onSubmit={save}>
            <input
              data-slot="bots-input"
              type="text"
              aria-label={t("bots.daily.capLabel")}
              placeholder={t("bots.daily.capPlaceholder")}
              value={shown()}
              onInput={(event) => {
                setDraft(event.currentTarget.value)
                setSaved(false)
              }}
            />
            <button type="submit" data-slot="bots-btn">
              {t("bots.daily.capSave")}
            </button>
          </form>
          <span data-slot="bots-hint">{t("bots.daily.capHint")}</span>
          <Show when={saved()}>
            <span data-slot="bots-hint">{t("bots.daily.capSaved")}</span>
          </Show>
          <Show when={problem()}>{(text) => <p data-slot="bots-problem">{text()}</p>}</Show>
        </Show>
      </section>
    </Show>
  )
}
