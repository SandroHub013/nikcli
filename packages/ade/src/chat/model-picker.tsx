/*
 * The model chip and its menu (composer-chip, pezzo 2), for the Chat's
 * composer and the bot's: search on top, then Recenti, Gratuiti, and «A
 * consumo» kept hidden until asked.
 *
 * While the catalog is read, or when it could not be, the chip keeps saying
 * the current model: the menu says why the list is not there, with Riprova,
 * and nothing is emptied (the catalog review's condition 3).
 */
import { createMemo, createSignal, Match, Switch } from "solid-js"
import { t } from "../i18n"
import { ChipMenu } from "./chip-menu"
import type { ModelSourceState } from "./model-source"
import type { ChatModelChoice, ModelRef } from "./model"
import { chipText, modelMenuItems, pickerSections } from "./picker"
import "./picker.css"

export interface ModelPickerProps {
  readonly value: string
  readonly models: readonly ChatModelChoice[]
  /** How the list is read; absent, `models` is the list. */
  readonly state?: ModelSourceState
  readonly recent?: readonly ModelRef[]
  /** An option for «no model of its own», first, with what it says. */
  readonly defaultLabel?: string
  /** A value the list lacks, as the chip says it. */
  readonly fallback?: (value: string) => string
  /** A value the list may lack, offered first as itself: a bot's saved model is not dropped unseen. */
  readonly kept?: string
  readonly label: string
  readonly disabled?: boolean
  readonly below?: boolean
  readonly onOpen?: () => void
  readonly onRetry?: () => void
  readonly onChoose: (value: string) => void
}

export function ModelPicker(props: ModelPickerProps) {
  const [query, setQuery] = createSignal("")
  const [showPaid, setShowPaid] = createSignal(false)
  const sections = createMemo(() =>
    pickerSections({ models: props.models, query: query(), recent: props.recent ?? [], showPaid: showPaid() }),
  )
  const items = createMemo(() =>
    modelMenuItems({
      sections: sections(),
      models: props.models,
      query: query(),
      ...(props.defaultLabel !== undefined ? { defaultLabel: props.defaultLabel } : {}),
      ...(props.kept ? { kept: props.kept } : {}),
      ...(props.fallback ? { keptLabel: props.fallback } : {}),
    }),
  )
  const text = () =>
    chipText(props.value, props.models, props.fallback ?? ((value) => value), props.defaultLabel ?? t("chat.model.choose"))
  const state = () => props.state ?? { kind: "ready" as const, models: props.models }

  return (
    <ChipMenu
      kind="model"
      label={props.label}
      text={text()}
      value={props.value}
      items={items()}
      disabled={props.disabled}
      below={props.below}
      search={{ placeholder: t("picker.search"), query: query(), onQuery: setQuery }}
      empty={state().kind === "ready" ? t("picker.none") : undefined}
      status={
        // Nothing to say once the list is there: an empty line would sit over it.
        state().kind === "ready" ? undefined : <Switch>
          <Match when={state().kind === "loading" || state().kind === "idle"}>
            <span data-slot="chip-note">{t("picker.loading")}</span>
          </Match>
          <Match when={state().kind === "failed" && state()}>
            {(failed) => (
              <span data-slot="chip-note" data-state="error" role="alert">
                {t("picker.failed", (failed() as { reason: string }).reason)}{" "}
                <button type="button" data-slot="chip-retry" onClick={() => props.onRetry?.()}>
                  {t("picker.retry")}
                </button>
              </span>
            )}
          </Match>
        </Switch>
      }
      footer={
        sections().paidHidden > 0 ? (
          <span data-slot="chip-note">
            {t("picker.paidHidden", sections().paidHidden)}{" "}
            <button type="button" data-slot="chip-retry" onPointerDown={(event) => event.preventDefault()} onClick={() => setShowPaid(true)}>
              {t("picker.showPaid")}
            </button>
          </span>
        ) : undefined
      }
      {...(props.onOpen ? { onOpen: props.onOpen } : {})}
      onChoose={props.onChoose}
    />
  )
}
