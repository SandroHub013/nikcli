/**
 * The Routine section of a bot's card (B11).
 *
 * Shown only where the list allows routines (`routineOffer`); elsewhere the
 * reason and the source, and nothing to press. The logic is in `routine.ts`:
 * this draws the book and hands the user's choices back.
 */

import { createMemo, createSignal, For, Show } from "solid-js"
import { t } from "../i18n"
import type { BotAccount } from "./account"
import type { AgentFile } from "./nikcli"
import {
  describeCap,
  describeEvery,
  formatNext,
  logOn,
  modeLabel,
  nextRun,
  routineOffer,
  routineProblem,
  type Routine,
  type RoutineBook,
  type RoutineEvery,
  type RoutineSpend,
} from "./routine"
import { runnerById } from "./runners"

export interface RoutineDraft {
  readonly prompt: string
  readonly every: RoutineEvery
  readonly spend?: RoutineSpend
}

export interface RoutinePanelDeps {
  readonly book: () => RoutineBook
  readonly runningId: () => string | undefined
  readonly now: () => number
  /** Saves a routine the user agreed to; the problem, if it cannot be saved. */
  readonly add: (bot: AgentFile, draft: RoutineDraft, cwd: string | undefined) => Promise<string | undefined>
  readonly remove: (id: string) => void
  readonly pause: (id: string, paused: boolean) => void
  /** The user agreed again: the consent as things are now, and the suspension lifted. */
  readonly reconsent: (bot: AgentFile, id: string) => Promise<string | undefined>
  readonly openSource: (url: string) => void
}

export function RoutineSection(props: {
  bot: AgentFile
  account: BotAccount
  projectRoot?: string | undefined
  deps: RoutinePanelDeps
}) {
  const runner = () => runnerById(props.bot.runner)
  const offer = createMemo(() => routineOffer(runner().id, props.account, props.bot.model))
  const mine = createMemo(() => props.deps.book().routines.filter((routine) => routine.bot === props.bot.path))

  const [composing, setComposing] = createSignal(false)
  const [prompt, setPrompt] = createSignal("")
  const [kind, setKind] = createSignal<RoutineEvery["kind"]>("hours")
  const [hours, setHours] = createSignal(4)
  const [time, setTime] = createSignal("09:00")
  const [perRun, setPerRun] = createSignal<number>()
  const [perDay, setPerDay] = createSignal<number>()
  const [agreed, setAgreed] = createSignal(false)
  const [problem, setProblem] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [reconsenting, setReconsenting] = createSignal<string>()

  const draft = (): RoutineDraft => {
    const cap = offer().cap
    const every: RoutineEvery = kind() === "hours" ? { kind: "hours", hours: hours() } : { kind: "daily", at: time() }
    if (!cap?.spendCapRequired) return { prompt: prompt(), every }
    return {
      prompt: prompt(),
      every,
      spend: { perRunUsd: perRun() ?? cap.perRunUsd ?? 0, perDayUsd: perDay() ?? cap.perDayUsd ?? 0 },
    }
  }

  const reset = () => {
    setComposing(false)
    setPrompt("")
    setAgreed(false)
    setProblem(undefined)
    setPerRun(undefined)
    setPerDay(undefined)
  }

  const save = async (event: Event) => {
    event.preventDefault()
    if (busy() || !agreed()) return
    const next = draft()
    const invalid = routineProblem(next, offer())
    if (invalid) return void setProblem(invalid)
    setBusy(true)
    const failed = await props.deps.add(props.bot, next, props.projectRoot)
    setBusy(false)
    if (failed) return void setProblem(failed)
    reset()
  }

  const consentText = () =>
    t("bots.routine.consent", runner().label, modeLabel(offer().mode), props.bot.model ?? t("bots.defaultModel"))

  const state = (routine: Routine) => {
    const log = logOn(props.deps.book(), routine.id, props.deps.now())
    if (props.deps.runningId() === routine.id) return { tone: "on", text: t("bots.routine.state.running") }
    if (log.suspended) return { tone: "error", text: t("bots.routine.state.suspended", log.suspended) }
    if (routine.paused) return { tone: "wait", text: t("bots.routine.state.paused") }
    return { tone: "on", text: t("bots.routine.state.on") }
  }

  const Source = () => (
    <Show when={offer().source}>
      {(url) => (
        <div data-slot="routine-source">
          <button type="button" data-slot="bots-link" onClick={() => props.deps.openSource(url())}>
            {t("bots.routine.source")}
          </button>
          <Show when={offer().checked}>
            {(date) => <span data-slot="gateway-meta">{t("bots.routine.checked", date())}</span>}
          </Show>
        </div>
      )}
    </Show>
  )

  return (
    <section data-slot="bots-card-section">
      <span data-slot="bots-label">{t("bots.routine.label")}</span>
      <Show
        when={offer().allowed}
        fallback={
          <>
            <span data-slot="bots-hint">{t("bots.routine.off", offer().reason ?? "")}</span>
            <Source />
          </>
        }
      >
        <Show when={mine().length === 0 && !composing()}>
          <span data-slot="bots-hint">{t("bots.routine.empty")}</span>
        </Show>

        <ul data-slot="gateway-list">
          <For each={mine()}>
            {(routine) => {
              const log = () => logOn(props.deps.book(), routine.id, props.deps.now())
              return (
                <li data-slot="routine-item">
                  <span data-slot="routine-prompt" title={routine.prompt}>
                    {routine.prompt}
                  </span>
                  <span data-slot="gateway-state" data-tone={state(routine).tone}>
                    <span data-slot="gateway-dot" aria-hidden="true" />
                    {state(routine).text}
                  </span>
                  <span data-slot="gateway-meta">
                    {describeEvery(routine.every)}
                    {" · "}
                    {t("bots.routine.next", formatNext(nextRun(routine, log(), props.deps.now()), props.deps.now()))}
                    {" · "}
                    {t("bots.routine.today", log().runs)}
                  </span>
                  <Show when={log().note}>{(note) => <span data-slot="bots-hint">{note()}</span>}</Show>
                  <span data-slot="gateway-row">
                    <Show
                      when={log().suspended}
                      fallback={
                        <button
                          type="button"
                          data-slot="bots-link"
                          onClick={() => props.deps.pause(routine.id, !routine.paused)}
                        >
                          {routine.paused ? t("bots.routine.resume") : t("bots.routine.pause")}
                        </button>
                      }
                    >
                      <button type="button" data-slot="bots-link" onClick={() => setReconsenting(routine.id)}>
                        {t("bots.routine.reconsent")}
                      </button>
                    </Show>
                    <button
                      type="button"
                      data-slot="bots-link"
                      data-tone="danger"
                      onClick={() => props.deps.remove(routine.id)}
                    >
                      {t("bots.routine.remove")}
                    </button>
                  </span>
                  <Show when={reconsenting() === routine.id}>
                    <div data-slot="gateway-confirm">
                      <span data-slot="bots-hint">{consentText()}</span>
                      <span data-slot="gateway-row">
                        <button type="button" data-slot="bots-btn" onClick={() => setReconsenting(undefined)}>
                          {t("bots.routine.cancel")}
                        </button>
                        <button
                          type="button"
                          data-slot="bots-btn"
                          data-tone="primary"
                          onClick={async () => {
                            const failed = await props.deps.reconsent(props.bot, routine.id)
                            setReconsenting(undefined)
                            if (failed) setProblem(failed)
                          }}
                        >
                          {t("bots.routine.reconsentConfirm")}
                        </button>
                      </span>
                    </div>
                  </Show>
                </li>
              )
            }}
          </For>
        </ul>

        <Show
          when={composing()}
          fallback={
            <button type="button" data-slot="bots-btn" onClick={() => setComposing(true)}>
              {t("bots.routine.new")}
            </button>
          }
        >
          <form data-slot="gateway-block" onSubmit={(event) => void save(event)}>
            <label data-slot="bots-field">
              <span data-slot="bots-label">{t("bots.routine.prompt")}</span>
              <textarea
                data-slot="bots-input"
                data-multiline="true"
                rows="3"
                value={prompt()}
                onInput={(event) => setPrompt(event.currentTarget.value)}
              />
            </label>
            <select
              data-slot="bots-input"
              value={kind()}
              onChange={(event) => setKind(event.currentTarget.value === "daily" ? "daily" : "hours")}
            >
              <option value="hours">{t("bots.routine.kind.hours")}</option>
              <option value="daily">{t("bots.routine.kind.daily")}</option>
            </select>
            <Show
              when={kind() === "hours"}
              fallback={
                <label data-slot="bots-field">
                  <span data-slot="bots-label">{t("bots.routine.time")}</span>
                  <input
                    data-slot="bots-input"
                    type="time"
                    value={time()}
                    onInput={(event) => setTime(event.currentTarget.value)}
                  />
                </label>
              }
            >
              <label data-slot="bots-field">
                <span data-slot="bots-label">{t("bots.routine.hours")}</span>
                <input
                  data-slot="bots-input"
                  type="number"
                  min="1"
                  max="168"
                  step="1"
                  value={hours()}
                  onInput={(event) => setHours(Number(event.currentTarget.value))}
                />
              </label>
            </Show>
            <Show when={offer().cap?.spendCapRequired}>
              <span data-slot="gateway-row">
                <label data-slot="bots-field">
                  <span data-slot="bots-label">{t("bots.routine.spend.perRun")}</span>
                  <input
                    data-slot="bots-input"
                    type="number"
                    min="0.01"
                    step="0.01"
                    max={String(offer().cap?.perRunUsd ?? "")}
                    value={perRun() ?? offer().cap?.perRunUsd ?? ""}
                    onInput={(event) => setPerRun(Number(event.currentTarget.value))}
                  />
                </label>
                <label data-slot="bots-field">
                  <span data-slot="bots-label">{t("bots.routine.spend.perDay")}</span>
                  <input
                    data-slot="bots-input"
                    type="number"
                    min="0.01"
                    step="0.01"
                    max={String(offer().cap?.perDayUsd ?? "")}
                    value={perDay() ?? offer().cap?.perDayUsd ?? ""}
                    onInput={(event) => setPerDay(Number(event.currentTarget.value))}
                  />
                </label>
              </span>
            </Show>
            <Show when={offer().cap}>
              {(cap) => <span data-slot="bots-hint">{t("bots.routine.cap", describeCap(cap()))}</span>}
            </Show>
            <Source />
            <label data-slot="routine-consent">
              <input type="checkbox" checked={agreed()} onChange={(event) => setAgreed(event.currentTarget.checked)} />
              <span>{consentText()}</span>
            </label>
            <Show when={problem()}>{(text) => <p data-slot="bots-problem">{text()}</p>}</Show>
            <span data-slot="gateway-row">
              <button type="button" data-slot="bots-btn" onClick={reset}>
                {t("bots.routine.cancel")}
              </button>
              <button type="submit" data-slot="bots-btn" data-tone="primary" disabled={busy() || !agreed()}>
                {t("bots.routine.save")}
              </button>
            </span>
          </form>
        </Show>
        <Show when={!composing() && problem()}>{(text) => <p data-slot="bots-problem">{text()}</p>}</Show>
      </Show>
    </section>
  )
}
