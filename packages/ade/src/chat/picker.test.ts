import { describe, expect, test } from "bun:test"
import { t } from "../i18n"
import type { ChatModelChoice } from "./model"
import {
  chipText,
  effortLabel,
  effortValue,
  hasEfforts,
  modelChipLabel,
  modelMenuItems,
  moveActive,
  pickerSections,
  pickerValues,
  searchModels,
} from "./picker"

const model = (providerID: string, modelID: string, name: string, free: boolean): ChatModelChoice => ({
  id: modelID,
  providerID,
  modelID,
  name,
  providerName: providerID === "openrouter" ? "OpenRouter" : "OpenCode Zen",
  free,
  label: `${name} (${free ? "gratis" : "$3/M"})`,
})

const QWEN = model("openrouter", "qwen/qwen3-coder:free", "Qwen3 Coder", true)
const GEMMA = model("openrouter", "google/gemma-4-31b-it:free", "Gemma 4 31B", true)
const BUNNY = model("opencode", "space-bunny", "Space Bunny", true)
const SONNET = model("openrouter", "anthropic/claude-sonnet-5", "Claude Sonnet 5", false)
const GPT = model("opencode", "gpt-5.6", "GPT 5.6", false)
const ALL = [QWEN, SONNET, GEMMA, GPT, BUNNY]

describe("the model menu's search", () => {
  test("every word must match the name, the id or the provider, in any case", () => {
    expect(searchModels(ALL, "qwen coder")).toEqual([QWEN])
    expect(searchModels(ALL, "OPENCODE")).toEqual([GPT, BUNNY])
    expect(searchModels(ALL, "gemma-4")).toEqual([GEMMA])
    expect(searchModels(ALL, "qwen sonnet")).toEqual([])
    expect(searchModels(ALL, "  ")).toEqual(ALL)
  })
})

describe("the model menu's sections", () => {
  test("paid models stay hidden, and counted, until asked for", () => {
    const hidden = pickerSections({ models: ALL })
    expect(hidden.free).toEqual([QWEN, GEMMA, BUNNY])
    expect(hidden.paid).toEqual([])
    expect(hidden.paidHidden).toBe(2)
    const shown = pickerSections({ models: ALL, showPaid: true })
    expect(shown.paid).toEqual([SONNET, GPT])
    expect(shown.paidHidden).toBe(0)
  })

  test("a recent model is listed once, among the recent, paid or not, newest first", () => {
    const sections = pickerSections({
      models: ALL,
      recent: [
        { providerID: "openrouter", modelID: "anthropic/claude-sonnet-5" },
        { providerID: "opencode", modelID: "space-bunny" },
        { providerID: "gone", modelID: "not-in-catalog" },
      ],
    })
    expect(sections.recent).toEqual([SONNET, BUNNY])
    expect(sections.free).toEqual([QWEN, GEMMA])
    expect(sections.paidHidden).toBe(1)
  })

  test("the search narrows every section, the hidden count too", () => {
    const sections = pickerSections({ models: ALL, query: "opencode" })
    expect(sections.free).toEqual([BUNNY])
    expect(sections.paidHidden).toBe(1)
  })

  test("the lines: the default, a kept model the catalog lacks, then the sections under their headings", () => {
    const items = modelMenuItems({
      sections: pickerSections({ models: [QWEN, SONNET], recent: [{ providerID: "openrouter", modelID: "qwen/qwen3-coder:free" }], showPaid: true }),
      models: [QWEN, SONNET],
      defaultLabel: "predefinito di nikcli",
      kept: "openrouter/old/model:free",
      keptLabel: (value) => `«${value}»`,
    })
    expect(items).toEqual([
      { kind: "option", value: "", label: "predefinito di nikcli" },
      { kind: "option", value: "openrouter/old/model:free", label: "«openrouter/old/model:free»", hint: "openrouter/old/model:free" },
      { kind: "group", label: t("picker.recent") },
      { kind: "option", value: "openrouter/qwen/qwen3-coder:free", label: QWEN.label, hint: "OpenRouter · openrouter/qwen/qwen3-coder:free" },
      { kind: "group", label: t("picker.paidGroup") },
      { kind: "option", value: "openrouter/anthropic/claude-sonnet-5", label: SONNET.label, hint: "OpenRouter · openrouter/anthropic/claude-sonnet-5" },
    ])
  })

  test("a kept model the catalog has is not listed twice; a search lists only what it found", () => {
    const listed = modelMenuItems({ sections: pickerSections({ models: [QWEN] }), models: [QWEN], kept: "openrouter/qwen/qwen3-coder:free" })
    expect(listed.filter((item) => item.kind === "option").length).toBe(1)
    const searched = modelMenuItems({
      sections: pickerSections({ models: [QWEN], query: "qwen" }),
      models: [QWEN],
      query: "qwen",
      defaultLabel: "predefinito",
      kept: "openrouter/old/model:free",
    })
    expect(searched.map((item) => (item.kind === "option" ? item.value : item.label))).toEqual([
      t("picker.free"),
      "openrouter/qwen/qwen3-coder:free",
    ])
  })
})

describe("the keys in the menu", () => {
  const values = pickerValues(pickerSections({ models: [QWEN, GEMMA, SONNET], showPaid: true }), true)

  test("the values in the order shown, the default first", () => {
    expect(values).toEqual(["", "openrouter/qwen/qwen3-coder:free", "openrouter/google/gemma-4-31b-it:free", "openrouter/anthropic/claude-sonnet-5"])
  })

  test("the arrows step through and wrap around the ends", () => {
    expect(moveActive(values, undefined, 1)).toBe("")
    expect(moveActive(values, undefined, -1)).toBe("openrouter/anthropic/claude-sonnet-5")
    expect(moveActive(values, "", 1)).toBe("openrouter/qwen/qwen3-coder:free")
    expect(moveActive(values, "openrouter/anthropic/claude-sonnet-5", 1)).toBe("")
    expect(moveActive(values, "", -1)).toBe("openrouter/anthropic/claude-sonnet-5")
    expect(moveActive(values, "not/there", 1)).toBe("")
    expect(moveActive([], undefined, 1)).toBeUndefined()
  })
})

describe("what the chip says", () => {
  test("the model's name and whether it is free; a value the list lacks as the fallback reads it", () => {
    expect(modelChipLabel(QWEN)).toBe(`Qwen3 Coder · ${t("chat.model.free")}`)
    expect(modelChipLabel(SONNET)).toBe(`Claude Sonnet 5 · ${t("picker.paid")}`)
    const fallback = (value: string) => `id ${value}`
    expect(chipText("openrouter/qwen/qwen3-coder:free", ALL, fallback, "predefinito")).toBe(modelChipLabel(QWEN))
    // The catalog not read yet, or failed: the current model all the same, never an empty chip.
    expect(chipText("openrouter/qwen/qwen3-coder:free", [], fallback, "predefinito")).toBe("id openrouter/qwen/qwen3-coder:free")
    expect(chipText("", ALL, fallback, "predefinito")).toBe("predefinito")
  })
})

describe("the effort chip", () => {
  test("only one of the model's own levels is ever chosen", () => {
    expect(effortValue("high", ["low", "medium", "high"])).toBe("high")
    expect(effortValue("high", ["none", "thinking"])).toBe("")
    expect(effortValue(" medium ", ["medium"])).toBe("medium")
    expect(effortValue("high", undefined)).toBe("")
    expect(effortValue(undefined, ["low"])).toBe("")
  })

  test("there only for a model with levels", () => {
    expect(hasEfforts(["low"])).toBe(true)
    expect(hasEfforts([])).toBe(false)
    expect(hasEfforts(undefined)).toBe(false)
  })

  test("the usual levels in the user's language, a model's own name as it is", () => {
    expect(effortLabel("medium")).toBe(t("effort.medium"))
    expect(effortLabel("xhigh")).toBe(t("effort.xhigh"))
    expect(effortLabel("thinking")).toBe("thinking")
  })
})
