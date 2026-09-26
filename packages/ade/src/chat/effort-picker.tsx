/*
 * The effort chip (composer-chip, pezzo 2): there only when the model has
 * levels, and offering only those. A level the model does not have is shown
 * as the default and never chosen (`effortValue`).
 */
import { createMemo, Show } from "solid-js"
import { t } from "../i18n"
import { ChipMenu, type ChipMenuItem } from "./chip-menu"
import { effortLabel, effortValue, hasEfforts } from "./picker"
import "./picker.css"

export interface EffortPickerProps {
  readonly value: string
  /** The model's levels; none, or not known, and there is no chip. */
  readonly levels: readonly string[] | undefined
  readonly label?: string
  readonly disabled?: boolean
  readonly below?: boolean
  readonly onChoose: (value: string) => void
}

export function EffortPicker(props: EffortPickerProps) {
  const value = () => effortValue(props.value, props.levels)
  const items = createMemo<readonly ChipMenuItem[]>(() => [
    { kind: "option", value: "", label: t("picker.effortDefault") },
    ...(props.levels ?? []).map((level): ChipMenuItem => ({ kind: "option", value: level, label: effortLabel(level), hint: level })),
  ])
  return (
    <Show when={hasEfforts(props.levels)}>
      <ChipMenu
        kind="effort"
        label={props.label ?? t("picker.effort")}
        text={value() ? effortLabel(value()) : t("picker.effortDefault")}
        value={value()}
        items={items()}
        disabled={props.disabled}
        below={props.below}
        onChoose={props.onChoose}
      />
    </Show>
  )
}
