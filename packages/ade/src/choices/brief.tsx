/**
 * The head of a question, over its options or variants: what is asked, why
 * now, and what the writer recommends (Verifiche, da-scegliere, problem 5).
 * The register carried `question`, `why` and `recommend`, and neither card
 * showed them: the user chose with the title and the context alone.
 */
import { Show } from "solid-js"
import "./brief.css"
import { t } from "../i18n"

export interface BriefFields {
  readonly question?: string
  readonly why?: string
  readonly recommend?: { readonly option: string; readonly because?: string }
}

/** Whether there is anything to show: a card without these fields looks as it did. */
export function hasBrief(fields: BriefFields): boolean {
  return Boolean(fields.question || fields.why || fields.recommend)
}

export function Brief(props: { fields: BriefFields }) {
  return (
    <Show when={hasBrief(props.fields)}>
      <div data-slot="choice-brief">
        <Show when={props.fields.question}>
          <p data-slot="brief-question">{props.fields.question}</p>
        </Show>
        <Show when={props.fields.why}>
          <p data-slot="brief-why">
            <b>{t("choices.brief.why")}</b> {props.fields.why}
          </p>
        </Show>
        <Show when={props.fields.recommend}>
          {(recommend) => (
            <p data-slot="brief-recommend">{t("choices.brief.recommend", recommend().option, recommend().because)}</p>
          )}
        </Show>
      </div>
    </Show>
  )
}
