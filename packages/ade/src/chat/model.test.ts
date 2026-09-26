import { describe, expect, test } from "bun:test"

// ---------------------------------------------------------------------------
// C3: Models, pricing, agents, and ADE Test filtering
// ---------------------------------------------------------------------------

import {
  agentsFromList,
  catalogHasModel,
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

  test("a zero cost counts as free only for a provider running on the user's machine", () => {
    expect(isFreeModel({ id: "local/one", providerID: "ollama", cost: { input: 0, output: 0 } })).toBe(true)
    expect(isFreeModel({ id: "local/two", providerID: "lmstudio", cost: { input: 0, output: 0 } })).toBe(true)
    expect(isFreeModel({ id: "local/three", providerID: "ollama", cost: { input: 0 } })).toBe(false)
    expect(isFreeModel({ id: "local/four", providerID: "ollama", cost: { input: 0, output: 1 } })).toBe(false)
  })

  test("a provider that prices its catalogue keeps its free models", () => {
    // OpenCode Zen: 111 models, every one priced at its public per-token
    // figure, free tier at 0. Its free models are named after the tier and do
    // not end in ":free", which is the whole reason the suffix was not enough.
    expect(isFreeModel({ id: "space-bunny-free", providerID: "opencode", cost: { input: 0, output: 0 } })).toBe(true)
    expect(isFreeModel({ id: "ling-3.0-flash-fin-free", providerID: "opencode", cost: { input: 0, output: 0 } })).toBe(
      true,
    )
    expect(isFreeModel({ id: "big-pickle", providerID: "opencode", cost: { input: 0, output: 0 } })).toBe(true)
  })

  test("a provider that prices its catalogue still charges for its paid models", () => {
    expect(isFreeModel({ id: "gpt-5.4", providerID: "opencode", cost: { input: 2.5, output: 15 } })).toBe(false)
    expect(isFreeModel({ id: "claude-opus-5-5", providerID: "opencode", cost: { input: 4, output: 20 } })).toBe(false)
    expect(isFreeModel({ id: "gpt-5.4-nano", providerID: "opencode", cost: { input: 0.2, output: 1.25 } })).toBe(false)
  })

  test("a hosted provider with a zero cost is not free", () => {
    // What ADE Test showed as a thousand free models: ElevenLabs and the
    // kilo/* families price at 0 and bill by characters or credits instead.
    expect(isFreeModel({ id: "elevenlabs/tts-v2", providerID: "elevenlabs", cost: { input: 0, output: 0 } })).toBe(
      false,
    )
    expect(isFreeModel({ id: "kilo/7b", providerID: "kilo", cost: { input: 0, output: 0 } })).toBe(false)
    expect(isFreeModel({ id: "unknown/zero", cost: { input: 0, output: 0 } })).toBe(false)
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

/** A catalogue like the real one: a text-to-speech family and a hosted
 * family that both price at 0, one genuinely free model, one local model. */
const noisyCatalog: ProviderList = {
  all: [
    {
      id: "elevenlabs",
      name: "ElevenLabs",
      source: "api",
      env: ["ELEVENLABS_API_KEY"],
      options: {},
      models: {
        "eleven_v3": {
          id: "eleven_v3",
          providerID: "elevenlabs",
          name: "Eleven v3",
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          status: "active",
          capabilities: {
            temperature: false,
            reasoning: false,
            attachment: false,
            toolcall: false,
            input: { text: true, audio: true, image: false, video: false, pdf: false },
            output: { text: false, audio: true, image: false, video: false, pdf: false },
            interleaved: false,
          },
        } as any,
        "eleven_multilingual_v2": {
          id: "eleven_multilingual_v2",
          providerID: "elevenlabs",
          name: "Eleven Multilingual v2",
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          status: "active",
          capabilities: {
            temperature: false,
            reasoning: false,
            attachment: false,
            toolcall: false,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: false, audio: true, image: false, video: false, pdf: false },
            interleaved: false,
          },
        } as any,
      },
    },
    {
      id: "kilo",
      name: "Kilo",
      source: "api",
      env: ["KILO_API_KEY"],
      options: {},
      models: {
        "kilo-7b": {
          id: "kilo-7b",
          providerID: "kilo",
          name: "Kilo 7B",
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          status: "active",
          capabilities: {
            temperature: true,
            reasoning: false,
            attachment: false,
            toolcall: true,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: true, video: false, pdf: false },
            interleaved: false,
          },
        } as any,
      },
    },
    {
      id: "ollama",
      name: "Ollama",
      source: "config",
      env: [],
      options: {},
      models: {
        "qwen3:8b": {
          id: "qwen3:8b",
          providerID: "ollama",
          name: "Qwen3 8B",
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          status: "active",
          capabilities: {
            temperature: true,
            reasoning: false,
            attachment: false,
            toolcall: true,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false,
          },
        } as any,
      },
    },
    {
      id: "opencode",
      name: "OpenCode Zen",
      source: "api",
      env: ["OPENCODE_API_KEY"],
      options: {},
      models: {
        "space-bunny-free": {
          id: "space-bunny-free",
          providerID: "opencode",
          name: "Space Bunny Free",
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          status: "active",
          capabilities: {
            temperature: true,
            reasoning: true,
            attachment: true,
            toolcall: true,
            input: { text: true, audio: false, image: true, video: true, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: { field: "reasoning_content" },
          },
        } as any,
        "gpt-5.4-nano": {
          id: "gpt-5.4-nano",
          providerID: "opencode",
          name: "GPT-5.4 Nano",
          cost: { input: 0.2, output: 1.25, cache: { read: 0.02 } },
          status: "active",
          capabilities: {
            temperature: true,
            reasoning: true,
            attachment: false,
            toolcall: true,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false,
          },
        } as any,
      },
    },
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
          capabilities: {
            temperature: true,
            reasoning: true,
            attachment: false,
            toolcall: true,
            input: { text: true, audio: false, image: true, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false,
          },
        } as any,
        "eleven/tts-v2": {
          id: "eleven/tts-v2",
          providerID: "nikcli",
          name: "Eleven tts via nikcli",
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          status: "active",
          capabilities: {
            temperature: false,
            reasoning: false,
            attachment: false,
            toolcall: false,
            input: { text: true, audio: true, image: false, video: false, pdf: false },
            output: { text: false, audio: true, image: false, video: false, pdf: false },
            interleaved: false,
          },
        } as any,
      },
    },
  ],
  default: {},
  connected: ["elevenlabs", "kilo", "ollama", "opencode", "nikcli"],
}

describe("the selector shows chat models, and calls free only what is free (C3-bis)", () => {
  test("a model that answers in audio or images never reaches the selector", () => {
    const models = modelsFromProviderList(noisyCatalog, { isTest: false })
    const ids = models.map((m) => m.id)
    expect(ids).not.toContain("eleven_v3")
    expect(ids).not.toContain("eleven_multilingual_v2")
    expect(ids).not.toContain("eleven/tts-v2")
  })

  test("a chat model priced at zero on a hosted provider is offered but is not free", () => {
    const models = modelsFromProviderList(noisyCatalog, { isTest: false })
    const kilo = models.find((m) => m.id === "kilo-7b")
    expect(kilo).toBeDefined()
    expect(kilo!.free).toBe(false)
    // Not free, so not labelled gratis: this label was the bug.
    expect(kilo!.label).not.toContain("gratis")
    expect(kilo!.label).not.toContain("free")
  })

  test("the free models of a provider that prices its catalogue are offered in ADE Test", () => {
    const models = modelsFromProviderList(noisyCatalog, { isTest: true })
    const ids = models.map((m) => m.id)
    // Free, and not for the ":free" reason: it ends in "-free" and costs 0.
    expect(ids).toContain("space-bunny-free")
    // The same provider's paid model stays out.
    expect(ids).not.toContain("gpt-5.4-nano")
    const bunny = models.find((m) => m.id === "space-bunny-free")
    expect(bunny!.free).toBe(true)
    expect(bunny!.label).toContain("gratis")
  })

  test("a local model priced at zero is free", () => {
    const models = modelsFromProviderList(noisyCatalog, { isTest: false })
    const local = models.find((m) => m.id === "qwen3:8b")
    expect(local).toBeDefined()
    expect(local!.free).toBe(true)
  })

  test("ADE Test keeps the :free model and the local one, and drops the hosted zero-cost chat model", () => {
    const models = modelsFromProviderList(noisyCatalog, { isTest: true })
    const ids = models.map((m) => m.id)
    expect(ids).toContain("qwen3:8b")
    expect(ids).toContain("google/gemini-2.5-flash:free")
    expect(ids).toContain("space-bunny-free")
    // The whole point of C3-bis: still not free.
    expect(ids).not.toContain("kilo-7b")
    expect(models.every((m) => m.free)).toBe(true)
  })

  test("a model that says nothing about its capabilities is not thrown away", () => {
    const list: ProviderList = {
      all: [
        {
          id: "silenzioso",
          name: "Silenzioso",
          source: "api",
          env: [],
          options: {},
          models: {
            "senza-capacities": { id: "senza-capacities", providerID: "silenzioso", cost: { input: 1, output: 2 }, status: "active" } as any,
            "capacities-vuote": { id: "capacities-vuote", providerID: "silenzioso", cost: { input: 1, output: 2 }, status: "active", capabilities: {} } as any,
          },
        },
      ],
      default: {},
      connected: ["silenzioso"],
    }
    const models = modelsFromProviderList(list, { isTest: false })
    expect(models.map((m) => m.id).sort()).toEqual(["capacities-vuote", "senza-capacities"])
  })

  test("a model that answers in text but cannot call tools does not reach the selector", () => {
    const list: ProviderList = {
      all: [
        {
          id: "solo-testo",
          name: "Solo testo",
          source: "api",
          env: [],
          options: {},
          models: {
            "no-toolcall": {
              id: "no-toolcall",
              providerID: "solo-testo",
              cost: { input: 1, output: 2, cache: { read: 0, write: 0 } },
              status: "active",
              capabilities: {
                temperature: true,
                reasoning: false,
                attachment: false,
                toolcall: false,
                input: { text: true, audio: false, image: false, video: false, pdf: false },
                output: { text: true, audio: false, image: false, video: false, pdf: false },
                interleaved: false,
              },
            } as any,
          },
        },
      ],
      default: {},
      connected: ["solo-testo"],
    }
    expect(modelsFromProviderList(list, { isTest: false })).toEqual([])
  })
})

describe("formatModelPrice and formatModelLabel", () => {
  test("formats free models in Italian as gratis", () => {
    setLocalePreference("it")
    expect(formatModelPrice({ input: 0, output: 0 }, true)).toBe("gratis")
    expect(formatModelLabel("Gemini Flash", { input: 0, output: 0 }, true)).toBe("Gemini Flash · gratis")
  })

  test("formats free models in English as free", () => {
    setLocalePreference("en")
    expect(formatModelPrice({ input: 0, output: 0 }, true)).toBe("free")
    expect(formatModelLabel("Gemini Flash", { input: 0, output: 0 }, true)).toBe("Gemini Flash · free")
    setLocalePreference("it")
  })

  test("formats paid models with input and output $/M tokens", () => {
    expect(formatModelPrice({ input: 3, output: 15 }, false)).toBe("$3/$15 /M")
    expect(formatModelLabel("Claude Sonnet", { input: 3, output: 15 }, false)).toBe("Claude Sonnet · $3/$15 /M")
  })

  test("formats paid models with equal input and output price", () => {
    expect(formatModelPrice({ input: 5, output: 5 }, false)).toBe("$5/M")
  })

  test("a model that is not free is never labelled gratis, whatever its cost says", () => {
    setLocalePreference("it")
    // A hosted provider that prices at 0 and bills by characters instead: the
    // dash says the price is not per token, without claiming it is free.
    expect(formatModelPrice({ input: 0, output: 0 }, false)).toBe("—")
    expect(formatModelLabel("Kilo 7B", { input: 0, output: 0 }, false)).toBe("Kilo 7B · —")
    // No price data at all is not a price of zero.
    expect(formatModelPrice(undefined, false)).toBe("—")
    expect(formatModelLabel("Sconosciuto", undefined, false)).toBe("Sconosciuto · —")
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
    expect(freeModel?.label).toContain("· gratis")
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
    expect(freeModel?.label).toContain("· free")
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
    // Two local providers, so both models are free and both stay in the list.
    // What this asks is whether one id from two providers stays two models,
    // not what makes a model free.
    const sharedIdList: ProviderList = {
      all: [
        {
          id: "ollama",
          name: "Ollama",
          source: "config",
          env: [],
          options: {},
          models: {
            "llama-3": {
              id: "llama-3",
              name: "Llama 3 (A)",
              providerID: "ollama",
              cost: { input: 0, output: 0 },
            } as any,
          },
        },
        {
          id: "lmstudio",
          name: "LM Studio",
          source: "config",
          env: [],
          options: {},
          models: {
            "llama-3": {
              id: "llama-3",
              name: "Llama 3 (B)",
              providerID: "lmstudio",
              cost: { input: 0, output: 0 },
            } as any,
          },
        },
      ],
      default: {},
      connected: ["ollama", "lmstudio"],
    }

    const models = modelsFromProviderList(sharedIdList, { isTest: true })
    expect(models.length).toBe(2)

    const choiceA = validateSelectedModel({ providerID: "ollama", modelID: "llama-3" }, models, true)
    const choiceB = validateSelectedModel({ providerID: "lmstudio", modelID: "llama-3" }, models, true)

    expect(choiceA).toEqual({ providerID: "ollama", modelID: "llama-3" })
    expect(choiceB).toEqual({ providerID: "lmstudio", modelID: "llama-3" })
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

describe("catalogHasModel", () => {
  const list = {
    all: [
      { id: "openrouter", name: "OpenRouter", models: { "nvidia/nemotron-3.5-lightning:free": { id: "nvidia/nemotron-3.5-lightning:free" } } },
      { id: "anthropic", name: "Anthropic", models: { "claude-x": { id: "claude-x" } } },
    ],
    default: {},
    connected: ["openrouter"],
  } as unknown as ProviderList

  test("a model of a connected provider is there; one that left, or of a provider not connected, is not", () => {
    expect(catalogHasModel(list, { providerID: "openrouter", modelID: "nvidia/nemotron-3.5-lightning:free" })).toBe(true)
    expect(catalogHasModel(list, { providerID: "openrouter", modelID: "nex-agi/nex-n2.5-mini:free" })).toBe(false)
    expect(catalogHasModel(list, { providerID: "anthropic", modelID: "claude-x" })).toBe(false)
    expect(catalogHasModel(list, { providerID: "openrouter", modelID: "constructor" })).toBe(false)
  })

  test("no catalog, or one without its lists, is not known: the server decides", () => {
    expect(catalogHasModel(undefined, { providerID: "openrouter", modelID: "x" })).toBeUndefined()
    expect(catalogHasModel({ all: [] } as unknown as ProviderList, { providerID: "openrouter", modelID: "x" })).toBeUndefined()
  })
})

/* Modello assente review, M1: the menu offers only what the send accepts. */
describe("the selector and the send look at the same list", () => {
  test("a provider without a key is not in the menu; a list without `connected` is not filtered", () => {
    const list = {
      all: [
        { id: "openrouter", name: "OpenRouter", models: { "a/b:free": { id: "a/b:free", name: "B" } } },
        { id: "bothub", name: "BotHub", models: { "gemma:free": { id: "gemma:free", name: "Gemma" } } },
      ],
      default: {},
      connected: ["openrouter"],
    } as unknown as ProviderList
    const offered = modelsFromProviderList(list)
    expect(offered.map((m) => `${m.providerID}/${m.modelID}`)).toEqual(["openrouter/a/b:free"])
    for (const choice of offered) expect(catalogHasModel(list, choice)).toBe(true)
    const { connected: _none, ...unknown } = list
    expect(modelsFromProviderList(unknown as unknown as ProviderList)).toHaveLength(2)
  })
})
