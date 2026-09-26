import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { ConfigProviders } from "@nikcli-ai/sdk/client"
import {
  configuredHasModel,
  modelsFromConfigProviders,
  readableModelName,
  recentModels,
  rememberModel,
  RECENT_MODELS_MAX,
  variantsOf,
  type RecentStorage,
} from "./model"
import { t } from "../i18n"

/*
 * Composer-chip, pezzo 1: one catalog for the Chat and the bots, from
 * `GET /config/providers`, the providers the server can run with each
 * model's variants after the configuration's overrides.
 */

const CONFIGURED = {
  providers: [
    {
      id: "openrouter",
      name: "OpenRouter",
      // The provider's key comes in this answer: the catalog never keeps it.
      key: "sk-finta",
      models: {
        "qwen/qwen3-coder:free": {
          id: "qwen/qwen3-coder:free",
          providerID: "openrouter",
          name: "Qwen3 Coder (free)",
          capabilities: { reasoning: true, toolcall: true, output: { text: true } },
          cost: { input: 0, output: 0 },
          limit: { context: 262_000 },
          variants: { low: {}, medium: {}, high: {}, max: { disabled: true } },
        },
        "nvidia/nemotron:free": {
          id: "nvidia/nemotron:free",
          providerID: "openrouter",
          name: "Nemotron",
          capabilities: { reasoning: false, toolcall: true, output: { text: true } },
        },
        "anthropic/claude-sonnet-5": {
          id: "anthropic/claude-sonnet-5",
          providerID: "openrouter",
          name: "Claude Sonnet 5",
          cost: { input: 3, output: 15 },
          capabilities: { toolcall: true, output: { text: true } },
          variants: { high: {} },
        },
        "some/tts": { id: "some/tts", providerID: "openrouter", name: "Voce", capabilities: { toolcall: false, output: { text: false } } },
      },
    },
  ],
  default: { openrouter: "qwen/qwen3-coder:free" },
} as unknown as ConfigProviders

const QWEN = { providerID: "openrouter", modelID: "qwen/qwen3-coder:free" }

describe("the catalog from /config/providers", () => {
  test("chat models only, with a name to read, free or paid, and their variants", () => {
    const models = modelsFromConfigProviders(CONFIGURED)
    expect(models.map((model) => model.id)).toEqual(["qwen/qwen3-coder:free", "nvidia/nemotron:free", "anthropic/claude-sonnet-5"])
    const [qwen, nemotron, sonnet] = models
    expect(qwen).toMatchObject({ name: "Qwen3 Coder", free: true, context: 262_000, reasoning: true, tools: true, variants: ["low", "medium", "high"] })
    expect(qwen!.label).toBe(`Qwen3 Coder · ${t("chat.model.free")}`)
    expect(nemotron).toMatchObject({ name: "Nemotron", free: true, reasoning: false, variants: [] })
    expect(sonnet).toMatchObject({ free: false, variants: ["high"] })
    expect(JSON.stringify(models)).not.toContain("sk-finta")
  })

  test("in ADE Test, only the free ones", () => {
    expect(modelsFromConfigProviders(CONFIGURED, { isTest: true }).map((model) => model.id)).toEqual([
      "qwen/qwen3-coder:free",
      "nvidia/nemotron:free",
    ])
    expect(modelsFromConfigProviders(undefined)).toEqual([])
  })

  test("a name without the provider's «(free)» or «:free»", () => {
    expect(readableModelName("Qwen3 Coder (free)")).toBe("Qwen3 Coder")
    expect(readableModelName("  Gemma 4 31B (FREE) ")).toBe("Gemma 4 31B")
    expect(readableModelName("nvidia/nemotron-3-super:free")).toBe("nvidia/nemotron-3-super")
    expect(readableModelName("Free Model")).toBe("Free Model")
    expect(readableModelName("(free)")).toBe("(free)")
    // Seen live in OpenCode Zen's catalog: the word Free said it twice with «(gratis)».
    expect(readableModelName("Space Bunny Free", true)).toBe("Space Bunny")
    expect(readableModelName("LongCat 2.5 Preview Free (free)", true)).toBe("LongCat 2.5 Preview")
    expect(readableModelName("Space Bunny Free")).toBe("Space Bunny Free")
    expect(readableModelName("Free", true)).toBe("Free")
  })

  test("what the server can run, and each model's levels", () => {
    expect(configuredHasModel(CONFIGURED, QWEN)).toBe(true)
    expect(configuredHasModel(CONFIGURED, { providerID: "openrouter", modelID: "gone:free" })).toBe(false)
    expect(configuredHasModel(CONFIGURED, { providerID: "anthropic", modelID: "claude-x" })).toBe(false)
    expect(configuredHasModel(undefined, QWEN)).toBeUndefined()
    const models = modelsFromConfigProviders(CONFIGURED)
    expect(variantsOf(models, QWEN)).toEqual(["low", "medium", "high"])
    expect(variantsOf(models, { providerID: "openrouter", modelID: "nvidia/nemotron:free" })).toEqual([])
    expect(variantsOf(models, { providerID: "x", modelID: "y" })).toBeUndefined()
  })
})

function memory(): RecentStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) }
}

describe("the recent models, per project", () => {
  test("newest first, once each, at most five, per folder whatever its spelling", () => {
    const storage = memory()
    const root = "C:\\Progetti\\app"
    for (const id of ["a", "b", "c", "a", "d", "e", "f"]) rememberModel(storage, root, { providerID: "openrouter", modelID: `${id}:free` })
    expect(recentModels(storage, "c:/progetti/app/").map((ref) => ref.modelID)).toEqual(["f:free", "e:free", "d:free", "a:free", "c:free"])
    expect(RECENT_MODELS_MAX).toBe(5)
    expect(recentModels(storage, "C:\\Progetti\\altro")).toEqual([])
  })

  test("nothing kept without a project, and nothing read that is not a list", () => {
    const storage = memory()
    rememberModel(storage, undefined, QWEN)
    expect(storage.data.size).toBe(0)
    storage.setItem("ade.models.recent:c:/x", "{rotto")
    expect(recentModels(storage, "C:/x")).toEqual([])
  })
})

describe("the Chat reads the one catalog", () => {
  test("lint: the Chat reads the catalog from /config/providers and validates the model against it before a send", () => {
    const connection = readFileSync(join(import.meta.dir, "connection.ts"), "utf8")
    expect(connection).toContain("within(client.config.providers(), timeoutMs)")
    expect(connection).not.toContain("client.provider.list()")
    const store = readFileSync(join(import.meta.dir, "store.ts"), "utf8")
    expect(store).toContain("configuredHasModel((await catalog()).configProviders, model)")
    const view = readFileSync(join(import.meta.dir, "chat.tsx"), "utf8")
    expect(view).toContain("modelsFromConfigProviders(catalog.configProviders ?? props.configProviders, { isTest: testBuild })")
    expect(view).toContain("rememberModel(localStorage, props.projectRoot, validated)")
  })
})

describe("models of one name", () => {
  /* Model-picker review, BASSO c: the provider is on every row of the menu (`picker.test.ts`), not glued to repeated names. */
  test("keep their name; the menu tells them apart by the provider it shows on every row", () => {
    const configured = {
      providers: [
        { id: "opencode", name: "OpenCode Zen", models: { "nemotron-free": { id: "nemotron-free", name: "Nemotron 3 Ultra", cost: { input: 0, output: 0 } } } },
        { id: "openrouter", name: "OpenRouter", models: { "nvidia/nemotron:free": { id: "nvidia/nemotron:free", name: "Nemotron 3 Ultra (free)" }, "x/solo:free": { id: "x/solo:free", name: "Solo" } } },
      ],
      default: {},
    } as unknown as ConfigProviders
    const models = modelsFromConfigProviders(configured)
    expect(models.map((model) => model.name)).toEqual(["Nemotron 3 Ultra", "Nemotron 3 Ultra", "Solo"])
    expect(models.map((model) => model.providerName)).toEqual(["OpenCode Zen", "OpenRouter", "OpenRouter"])
    expect(models[1]!.label).toBe(`Nemotron 3 Ultra · ${t("chat.model.free")}`)
  })
})
