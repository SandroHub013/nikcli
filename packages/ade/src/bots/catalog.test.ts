import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { t } from "../i18n"
import { botModelLabel, catalogFree, nikcliModelVariants, parseModelCatalog } from "./catalog"

/* The shape of `nikcli models opencode --verbose`, with made-up models. */
const record = (id: string, input: number, output: number) =>
  [
    `opencode/${id}`,
    "{",
    `  "id": "${id}",`,
    `  "providerID": "opencode",`,
    `  "capabilities": {`,
    `    "toolcall": true`,
    `  },`,
    `  "cost": {`,
    `    "input": ${input},`,
    `    "output": ${output}`,
    `  }`,
    "}",
  ].join("\n")

const OPENCODE = [record("mario-free", 0, 0), record("mario-pro", 2.5, 15)].join("\n")

describe("whether a routine's model is free, by nikcli's catalog (B11 review, M2)", () => {
  test("the catalog is read record by record", () => {
    const models = parseModelCatalog(`${OPENCODE}\nrumore\n`)
    expect([...models.keys()]).toEqual(["opencode/mario-free", "opencode/mario-pro"])
    expect(models.get("opencode/mario-pro")?.cost).toEqual({ input: 2.5, output: 15 })
  })

  test("a provider that prices honestly: 0 is free, a price is not, and a model it does not list is not", async () => {
    const asked: string[] = []
    const load = async (provider: string) => (asked.push(provider), OPENCODE)
    expect(await catalogFree("opencode/mario-free", load)).toBe(true)
    expect(await catalogFree("opencode/mario-pro", load)).toBe(false)
    expect(await catalogFree("opencode/altro", load)).toBe(false)
    expect(asked).toEqual(["opencode", "opencode", "opencode"])
  })

  test("the suffix is free without asking; elsewhere 0 is a missing price, and nikcli is not asked", async () => {
    const asked: string[] = []
    const load = async (provider: string) => (asked.push(provider), OPENCODE)
    expect(await catalogFree("openrouter/mario/modello:free", load)).toBe(true)
    expect(await catalogFree("openrouter/mario/modello", load)).toBe(false)
    expect(await catalogFree("modello", load)).toBe(false)
    expect(asked).toEqual([])
  })

  test("a catalog that cannot be read makes the model paid", async () => {
    expect(await catalogFree("opencode/mario-free", async () => "")).toBe(false)
    expect(await catalogFree("opencode/mario-free", async () => Promise.reject(new Error("no")))).toBe(false)
  })
})

/* Prove dal vivo 2: the bot form's 385 models, free and paid, all looked alike. */
describe("the bot form's model list", () => {
  test("marks a free model as the Chat does, and leaves a paid one as its id", () => {
    expect(botModelLabel("openrouter/nvidia/nemotron-3.5-lightning:free")).toBe(
      `openrouter/nvidia/nemotron-3.5-lightning:free (${t("chat.model.free")})`,
    )
    expect(botModelLabel("openrouter/anthropic/claude-sonnet-5")).toBe("openrouter/anthropic/claude-sonnet-5")
  })

  test("is what the select shows, the pinned model included", () => {
    const form = readFileSync(join(import.meta.dir, "bots.tsx"), "utf8")
    expect(form).toContain("<For each={props.nikcliModels}>{(id) => <option value={id}>{botModelLabel(id)}</option>}</For>")
    expect(form).toContain('<option value={props.pinned}>{botModelLabel(props.pinned ?? "")}</option>')
  })
})

/* chat-bot-facili, pezzo 0: a nikcli bot's efforts are its model's variants. */
describe("a nikcli model's efforts, from its catalog", () => {
  // As `nikcli models openrouter --verbose` prints them (2026-09-26).
  const OPENROUTER = [
    "openrouter/google/gemma-4-31b-it:free",
    "{",
    '  "id": "google/gemma-4-31b-it:free",',
    '  "variants": {',
    '    "none": { "reasoning": { "effort": "none" } },',
    '    "thinking": { "reasoning": { "enabled": true } }',
    "  }",
    "}",
    "openrouter/plain/model:free",
    "{",
    '  "id": "plain/model:free"',
    "}",
  ].join("\n")
  const load = async (provider: string) => (provider === "openrouter" ? OPENROUTER : "")

  test("the variants a model has; none for one without; unknown for one not listed or unread", async () => {
    expect(parseModelCatalog(OPENROUTER).get("openrouter/google/gemma-4-31b-it:free")?.variants).toEqual(["none", "thinking"])
    expect(await nikcliModelVariants("openrouter/google/gemma-4-31b-it:free", load)).toEqual(["none", "thinking"])
    expect(await nikcliModelVariants("openrouter/plain/model:free", load)).toEqual([])
    expect(await nikcliModelVariants("openrouter/missing/one", load)).toBeUndefined()
    expect(await nikcliModelVariants("altro/x", load)).toBeUndefined()
    expect(await nikcliModelVariants("senza-provider", load)).toBeUndefined()
    expect(await nikcliModelVariants("openrouter/x", async () => Promise.reject(new Error("no")))).toBeUndefined()
  })

  test("the form offers them, not a fixed list", () => {
    const form = readFileSync(join(import.meta.dir, "bots.tsx"), "utf8")
    expect(form).toContain("(model) => nikcliModelVariants(model, loadCatalog),")
    // This model's only: a resource keeps the last model's value when the model is cleared (A occhio).
    expect(form).toContain('variants: runner().id === "nikcli" && props.model && !variants.loading ? variants() : undefined,')
    expect(form).toContain("<For each={efforts().options}>")
    expect(form).not.toContain("when={runner().efforts.length > 0}")
    // Said under the row, the whole width: the effort's column cut it to «predef» (A occhio).
    expect(form).toContain('<span data-slot="bots-hint" data-state="warn">\n          {t("bots.engine.effortStaleHint", efforts().stale ?? "")}')
  })
})
