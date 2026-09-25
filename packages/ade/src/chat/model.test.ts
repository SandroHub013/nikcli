import { describe, expect, test } from "bun:test"

// ---------------------------------------------------------------------------
// C3: Models, pricing, agents, and ADE Test filtering
// ---------------------------------------------------------------------------

import {
  agentsFromList,
  defaultAgentChoice,
  defaultModelChoice,
  formatModelLabel,
  formatModelPrice,
  isFreeModel,
  modelsFromProviderList,
  validateSelectedModel,
  sameModel,
  serializeModelRef,
  parseModelRef,
  type ModelRef,
} from "./model"
import type { ProviderList, Agent } from "@nikcli-ai/sdk/client"
import { setLocalePreference } from "../i18n/locale"

const mockProviderList: ProviderList = {
  all: [
    {
      id: "nikcli",
      name: "nikcli",
      source: "custom",
      env: [],
      options: {},
      models: {
        "google/gemini-2.5-flash:free": {
          id: "google/gemini-2.5-flash:free",
          providerID: "nikcli",
          name: "Gemini 2.5 Flash",
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          status: "active",
        } as any,
        "meta-llama/llama-3.3-70b-instruct:free": {
          id: "meta-llama/llama-3.3-70b-instruct:free",
          providerID: "nikcli",
          name: "Llama 3.3 70B",
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          status: "active",
        } as any,
      },
    },
    {
      id: "openrouter",
      name: "OpenRouter",
      source: "api",
      env: ["OPENROUTER_API_KEY"],
      options: {},
      models: {
        "openai/gpt-6-astra-pro": {
          id: "openai/gpt-6-astra-pro",
          providerID: "openrouter",
          name: "GPT-6 Astra Pro",
          cost: { input: 5, output: 20, cache: { read: 0.5, write: 1 } },
          status: "active",
        } as any,
        "anthropic/claude-sonnet-4.5": {
          id: "anthropic/claude-sonnet-4.5",
          providerID: "openrouter",
          name: "Claude Sonnet 4.5",
          cost: { input: 3, output: 15, cache: { read: 0.3, write: 1.5 } },
          status: "active",
        } as any,
        "qwen/qwen-2.5-coder-32b-instruct:free": {
          id: "qwen/qwen-2.5-coder-32b-instruct:free",
          providerID: "openrouter",
          name: "Qwen 2.5 Coder 32B Free",
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          status: "active",
        } as any,
      },
    },
  ],
  default: {
    nikcli: "google/gemini-2.5-flash:free",
    openrouter: "openai/gpt-6-astra-pro", // Note from Dario: default OpenRouter is paid.
  },
  connected: ["nikcli", "openrouter"],
}

describe("isFreeModel", () => {
  test("recognises free models by :free suffix in id", () => {
    expect(isFreeModel({ id: "google/gemini-2.5-flash:free" })).toBe(true)
    expect(isFreeModel({ id: "meta-llama/llama-3.3-70b-instruct:free" })).toBe(true)
  })

  test("recognises free models only when both input and output costs are zero numbers", () => {
    expect(isFreeModel({ id: "custom/local", cost: { input: 0, output: 0 } })).toBe(true)
    expect(isFreeModel({ id: "custom/local", cost: { input: 0 } })).toBe(false)
    expect(isFreeModel({ id: "custom/local", cost: { input: 0, output: 1 } })).toBe(false)
  })

  test("a nikcli model without cost is not free and does not enter ADE Test", () => {
    expect(isFreeModel({ id: "nikcli-bundled", providerID: "nikcli" })).toBe(false)

    const list: ProviderList = {
      all: [
        {
          id: "nikcli",
          name: "nikcli",
          source: "custom",
          env: [],
          options: {},
          models: {
            "custom-nocost": {
              id: "custom-nocost",
              name: "No Cost Model",
              providerID: "nikcli",
            } as any,
          },
        },
      ],
      default: {},
      connected: ["nikcli"],
    }
    const testModels = modelsFromProviderList(list, { isTest: true })
    expect(testModels.some((m) => m.name === "No Cost Model")).toBe(false)
  })

  test("recognises paid models", () => {
    expect(isFreeModel({ id: "openai/gpt-6-astra-pro", cost: { input: 5, output: 20 } })).toBe(false)
    expect(isFreeModel({ id: "anthropic/claude-sonnet-4.5", cost: { input: 3, output: 15 } })).toBe(false)
  })
})

describe("formatModelPrice and formatModelLabel", () => {
  test("formats free models in Italian as gratis", () => {
    setLocalePreference("it")
    expect(formatModelPrice({ input: 0, output: 0 }, true)).toBe("gratis")
    expect(formatModelLabel("Gemini Flash", { input: 0, output: 0 }, true)).toBe("Gemini Flash (gratis)")
  })

  test("formats free models in English as free", () => {
    setLocalePreference("en")
    expect(formatModelPrice({ input: 0, output: 0 }, true)).toBe("free")
    expect(formatModelLabel("Gemini Flash", { input: 0, output: 0 }, true)).toBe("Gemini Flash (free)")
    setLocalePreference("it")
  })

  test("formats paid models with input and output $/M tokens", () => {
    expect(formatModelPrice({ input: 3, output: 15 }, false)).toBe("$3/$15 /M")
    expect(formatModelLabel("Claude Sonnet", { input: 3, output: 15 }, false)).toBe("Claude Sonnet ($3/$15 /M)")
  })

  test("formats paid models with equal input and output price", () => {
    expect(formatModelPrice({ input: 5, output: 5 }, false)).toBe("$5/M")
  })
})

describe("modelsFromProviderList (C3)", () => {
  test("in standard mode includes all active models with price labels", () => {
    setLocalePreference("it")
    const models = modelsFromProviderList(mockProviderList, { isTest: false })
    expect(models.length).toBe(5)
    const freeCount = models.filter((m) => m.free).length
    const paidCount = models.filter((m) => !m.free).length
    expect(freeCount).toBe(3)
    expect(paidCount).toBe(2)

    const paidModel = models.find((m) => m.id === "anthropic/claude-sonnet-4.5")
    expect(paidModel?.label).toContain("$3/$15 /M")

    const freeModel = models.find((m) => m.id === "google/gemini-2.5-flash:free")
    expect(freeModel?.label).toContain("(gratis)")
  })

  test("in ADE Test mode includes ONLY free models (never a paid model)", () => {
    const testModels = modelsFromProviderList(mockProviderList, { isTest: true })
    expect(testModels.length).toBe(3)
    // Every single model in ADE Test must be free.
    expect(testModels.every((m) => m.free)).toBe(true)

    // Paid models must be absent in ADE Test.
    expect(testModels.some((m) => m.id === "openai/gpt-6-astra-pro")).toBe(false)
    expect(testModels.some((m) => m.id === "anthropic/claude-sonnet-4.5")).toBe(false)
  })

  test("in English uses 'free' instead of 'gratis'", () => {
    setLocalePreference("en")
    const models = modelsFromProviderList(mockProviderList, { isTest: true })
    const freeModel = models.find((m) => m.id === "google/gemini-2.5-flash:free")
    expect(freeModel?.label).toContain("(free)")
    setLocalePreference("it")
  })

  test("returns empty array without inventing models when provider list is null or empty", () => {
    expect(modelsFromProviderList(null)).toEqual([])
    expect(modelsFromProviderList(undefined)).toEqual([])
    expect(modelsFromProviderList({ all: [], default: {}, connected: [] })).toEqual([])
  })
})

describe("defaultModelChoice (C3)", () => {
  test("picks the config model if it is free", () => {
    const models = modelsFromProviderList(mockProviderList, { isTest: false })
    const choice = defaultModelChoice(models, "google/gemini-2.5-flash:free")
    expect(choice).toBeDefined()
    expect(choice!.id).toBe("google/gemini-2.5-flash:free")
    expect(choice!.free).toBe(true)
  })

  test("if config model is paid, falls back to the first free model, never paid", () => {
    const models = modelsFromProviderList(mockProviderList, { isTest: false })
    const choice = defaultModelChoice(models, "openai/gpt-6-astra-pro")
    expect(choice).toBeDefined()
    expect(choice!.free).toBe(true)
    expect(choice!.id).not.toBe("openai/gpt-6-astra-pro")
    expect(choice!.id).toBe("google/gemini-2.5-flash:free")
  })

  test("if no model is free, returns undefined (no default, send disabled)", () => {
    const onlyPaidModels = [
      {
        id: "paid/model-1",
        providerID: "p1",
        modelID: "model-1",
        name: "Paid 1",
        providerName: "P1",
        free: false,
        cost: { input: 10, output: 20 },
        label: "Paid 1",
      },
      {
        id: "paid/model-2",
        providerID: "p2",
        modelID: "model-2",
        name: "Paid 2",
        providerName: "P2",
        free: false,
        cost: { input: 5, output: 10 },
        label: "Paid 2",
      },
    ]
    const choice = defaultModelChoice(onlyPaidModels, "paid/model-1")
    expect(choice).toBeUndefined()

    const choiceNoCfg = defaultModelChoice(onlyPaidModels)
    expect(choiceNoCfg).toBeUndefined()
  })

  test("empty models returns undefined", () => {
    expect(defaultModelChoice([])).toBeUndefined()
  })
})

describe("agentsFromList and defaultAgentChoice (C3)", () => {
  const rawAgents: Agent[] = [
    { name: "assistant", mode: "primary", description: "General assistant", permission: [], options: {} },
    { name: "build", mode: "primary", description: "Build agent", permission: [], options: {} },
    { name: "planner", mode: "subagent", description: "Planner only", permission: [], options: {} },
    { name: "secret", mode: "primary", hidden: true, permission: [], options: {} },
  ]

  test("filters out subagents and hidden agents", () => {
    const agents = agentsFromList(rawAgents)
    expect(agents.map((a) => a.name)).toEqual(["assistant", "build"])
  })

  test("defaultAgentChoice prefers assistant", () => {
    const agents = agentsFromList(rawAgents)
    expect(defaultAgentChoice(agents)).toBe("assistant")
  })

  test("defaultAgentChoice falls back to first agent if assistant is not present", () => {
    const agents = [{ name: "build", description: "Build agent" }]
    expect(defaultAgentChoice(agents)).toBe("build")
  })

  test("returns empty array without inventing agents when agents list is null or empty", () => {
    expect(agentsFromList(null)).toEqual([])
    expect(agentsFromList(undefined)).toEqual([])
    expect(agentsFromList([])).toEqual([])
    expect(defaultAgentChoice([])).toBeUndefined()
  })
})

describe("validateSelectedModel (C3)", () => {
  const models = modelsFromProviderList(mockProviderList, { isTest: false })

  test("allows paid model in standard mode when explicitly chosen", () => {
    expect(validateSelectedModel("anthropic/claude-sonnet-4.5", models, false)).toEqual({
      providerID: "openrouter",
      modelID: "anthropic/claude-sonnet-4.5",
    })
  })

  test("rejects paid model in ADE Test mode even if stored in localStorage", () => {
    // Crucial safety guarantee: even if localStorage had a paid model from before,
    // in ADE Test it is refused and falls back to safe free default.
    expect(validateSelectedModel("anthropic/claude-sonnet-4.5", models, true)).toBeUndefined()
  })

  test("accepts free model in ADE Test mode", () => {
    expect(validateSelectedModel("google/gemini-2.5-flash:free", models, true)).toEqual({
      providerID: "nikcli",
      modelID: "google/gemini-2.5-flash:free",
    })
  })
})

describe("Model identity and ModelRef (C3 - Point 5)", () => {
  test("sameModel compares providerID and modelID", () => {
    expect(sameModel({ providerID: "p1", modelID: "m1" }, { providerID: "p1", modelID: "m1" })).toBe(true)
    expect(sameModel({ providerID: "p1", modelID: "m1" }, { providerID: "p2", modelID: "m1" })).toBe(false)
    expect(sameModel({ providerID: "p1", modelID: "m1" }, { providerID: "p1", modelID: "m2" })).toBe(false)
    expect(sameModel(null, { providerID: "p1", modelID: "m1" })).toBe(false)
    expect(sameModel(undefined, undefined)).toBe(false)
  })

  test("serializes and parses ModelRef", () => {
    const ref: ModelRef = { providerID: "nikcli", modelID: "google/gemini-2.5-flash:free" }
    expect(serializeModelRef(ref)).toBe("nikcli/google/gemini-2.5-flash:free")
    expect(parseModelRef("nikcli/google/gemini-2.5-flash:free")).toEqual(ref)
    expect(parseModelRef(JSON.stringify(ref))).toEqual(ref)
    expect(parseModelRef(null)).toBeUndefined()
    expect(parseModelRef("invalid")).toBeUndefined()
  })

  test("disambiguates same model ID across different providers", () => {
    const sharedIdList: ProviderList = {
      all: [
        {
          id: "providerA",
          name: "Provider A",
          source: "custom",
          env: [],
          options: {},
          models: {
            "llama-3": {
              id: "llama-3",
              name: "Llama 3 (A)",
              providerID: "providerA",
              cost: { input: 0, output: 0 },
            } as any,
          },
        },
        {
          id: "providerB",
          name: "Provider B",
          source: "custom",
          env: [],
          options: {},
          models: {
            "llama-3": {
              id: "llama-3",
              name: "Llama 3 (B)",
              providerID: "providerB",
              cost: { input: 0, output: 0 },
            } as any,
          },
        },
      ],
      default: {},
      connected: ["providerA", "providerB"],
    }

    const models = modelsFromProviderList(sharedIdList, { isTest: true })
    expect(models.length).toBe(2)

    const choiceA = validateSelectedModel({ providerID: "providerA", modelID: "llama-3" }, models, true)
    const choiceB = validateSelectedModel({ providerID: "providerB", modelID: "llama-3" }, models, true)

    expect(choiceA).toEqual({ providerID: "providerA", modelID: "llama-3" })
    expect(choiceB).toEqual({ providerID: "providerB", modelID: "llama-3" })
    expect(sameModel(choiceA, choiceB)).toBe(false)
  })

  test("defaultModelChoice matches ModelRef config model", () => {
    const models = modelsFromProviderList(mockProviderList, { isTest: false })
    const choice = defaultModelChoice(models, {
      providerID: "nikcli",
      modelID: "google/gemini-2.5-flash:free",
    })
    expect(choice).toBeDefined()
    expect(choice!.providerID).toBe("nikcli")
    expect(choice!.modelID).toBe("google/gemini-2.5-flash:free")
  })
})
