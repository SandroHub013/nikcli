/*
 * What the model and effort chips show, and in what order (composer-chip,
 * pezzo 2).
 *
 * The rules live here, apart from the components, so the Chat's composer and
 * the bot's use the same ones and a test reads them without a DOM: the
 * search, the sections (recent, free, paid kept hidden until asked), the
 * keys that move through them, and an effort that is only ever one of the
 * model's own variants.
 */
import { t } from "../i18n"
import { sameModel, serializeModelRef, type ChatModelChoice, type ModelRef } from "./model"

/** The words of a query, each of which a model must match somewhere in its names. */
function words(query: string): readonly string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

/** The models whose name, id or provider holds every word of `query`, in their order. */
export function searchModels(models: readonly ChatModelChoice[], query: string): readonly ChatModelChoice[] {
  const wanted = words(query)
  if (wanted.length === 0) return models
  return models.filter((model) => {
    const text = `${model.name} ${model.modelID} ${model.providerName} ${model.providerID}`.toLowerCase()
    return wanted.every((word) => text.includes(word))
  })
}

export interface PickerSections {
  /** The project's recent models that are still in the catalog, newest first. */
  readonly recent: readonly ChatModelChoice[]
  readonly free: readonly ChatModelChoice[]
  /** The paid models shown: none until the user asks for them. */
  readonly paid: readonly ChatModelChoice[]
  /** How many paid models match and are hidden. */
  readonly paidHidden: number
}

/**
 * The menu's sections. A recent model is listed once, among the recent ones,
 * paid or not: the user chose it. The paid ones stay hidden until `showPaid`,
 * so a click cannot move a conversation onto a model that costs by mistake.
 */
export function pickerSections(input: {
  readonly models: readonly ChatModelChoice[]
  readonly query?: string
  readonly recent?: readonly ModelRef[]
  readonly showPaid?: boolean
}): PickerSections {
  const found = searchModels(input.models, input.query ?? "")
  const recent = (input.recent ?? [])
    .map((ref) => found.find((model) => sameModel(model, ref)))
    .filter((model): model is ChatModelChoice => model !== undefined)
  const rest = found.filter((model) => !recent.includes(model))
  const paid = rest.filter((model) => !model.free)
  return {
    recent,
    free: rest.filter((model) => model.free),
    paid: input.showPaid ? paid : [],
    paidHidden: input.showPaid ? 0 : paid.length,
  }
}

export type ChipMenuItem =
  | { readonly kind: "group"; readonly label: string }
  | {
      readonly kind: "option"
      readonly value: string
      readonly label: string
      readonly hint?: string
      /** Said apart, on the right of the row: a model's provider. */
      readonly detail?: string
    }

/**
 * The model menu's lines, in order: the default, a kept value the catalog
 * lacks (a bot's saved model is not dropped unseen), then the sections under
 * their headings. The default and the kept value are for browsing: a search
 * lists only what it found.
 */
export function modelMenuItems(input: {
  readonly sections: PickerSections
  readonly models: readonly ChatModelChoice[]
  readonly query?: string
  readonly defaultLabel?: string
  readonly kept?: string
  readonly keptLabel?: (value: string) => string
}): readonly ChipMenuItem[] {
  const browsing = !(input.query ?? "").trim()
  const kept = input.kept
  const keptApart = browsing && kept && !input.models.some((model) => serializeModelRef(model) === kept) ? kept : undefined
  const option = (model: ChatModelChoice): ChipMenuItem => ({
    kind: "option",
    value: serializeModelRef(model),
    label: model.label,
    hint: `${model.providerName} · ${serializeModelRef(model)}`,
    // On every row, not only where a name repeats (model-picker review, BASSO c).
    detail: model.providerName,
  })
  const group = (label: string, models: readonly ChatModelChoice[]): readonly ChipMenuItem[] =>
    models.length ? [{ kind: "group", label }, ...models.map(option)] : []
  return [
    ...(browsing && input.defaultLabel !== undefined ? [{ kind: "option", value: "", label: input.defaultLabel } as const] : []),
    ...(keptApart ? [{ kind: "option", value: keptApart, label: (input.keptLabel ?? ((value: string) => value))(keptApart), hint: keptApart } as const] : []),
    ...group(t("picker.recent"), input.sections.recent),
    ...group(t("picker.free"), input.sections.free),
    ...group(t("picker.paidGroup"), input.sections.paid),
  ]
}

/** The values the keys move through, in the order they are shown: the default first when there is one. */
export function pickerValues(sections: PickerSections, withDefault: boolean): readonly string[] {
  return [
    ...(withDefault ? [""] : []),
    ...[...sections.recent, ...sections.free, ...sections.paid].map((model) => serializeModelRef(model)),
  ]
}

/**
 * The value the arrow keys land on: one step from `active`, around the ends.
 * With nothing active the first step goes to the first value (or the last,
 * going up).
 */
export function moveActive(values: readonly string[], active: string | undefined, step: 1 | -1): string | undefined {
  if (values.length === 0) return undefined
  const at = active === undefined ? -1 : values.indexOf(active)
  if (at === -1) return step === 1 ? values[0] : values[values.length - 1]
  return values[(at + step + values.length) % values.length]
}

/** What the chip says of a model: the same line as the menu's, «Qwen3 Coder · gratis». */
export function modelChipLabel(model: ChatModelChoice): string {
  return model.label
}

/**
 * What the chip says of a value: the model's name when the catalog has it,
 * otherwise the value itself as `fallback` reads it (the catalog may not be
 * loaded yet, or may have lost the model), otherwise the default.
 */
export function chipText(
  value: string,
  models: readonly ChatModelChoice[],
  fallback: (value: string) => string,
  defaultLabel: string,
): string {
  if (!value) return defaultLabel
  const model = models.find((entry) => serializeModelRef(entry) === value)
  return model ? modelChipLabel(model) : fallback(value)
}

/**
 * The effort shown and sent: one of the model's variants, or the default.
 * A level the model does not have is never sent, whatever was saved.
 */
export function effortValue(value: string | undefined, variants: readonly string[] | undefined): string {
  const wanted = value?.trim() ?? ""
  return wanted && variants?.includes(wanted) ? wanted : ""
}

/** Whether there is an effort to choose at all: only for a model with variants. */
export function hasEfforts(variants: readonly string[] | undefined): boolean {
  return (variants?.length ?? 0) > 0
}

type EffortKey = "effort.none" | "effort.minimal" | "effort.low" | "effort.medium" | "effort.high" | "effort.xhigh" | "effort.max" | "effort.thinking"

/* The ids nikcli's models use, in words (model-picker review, BASSO a): «none» and «thinking» were shown raw. */
const EFFORT_NAMES: Readonly<Record<string, EffortKey>> = {
  none: "effort.none",
  thinking: "effort.thinking",
  minimal: "effort.minimal",
  low: "effort.low",
  medium: "effort.medium",
  high: "effort.high",
  xhigh: "effort.xhigh",
  max: "effort.max",
}

/** A level in the user's language when it is one of the usual ones; a model's own name as it is. */
export function effortLabel(level: string): string {
  const key = EFFORT_NAMES[level]
  return key ? t(key) : level
}
