import { describe, expect, test } from "bun:test"
import {
  appendDelta,
  appendMessage,
  conversationTitle,
  createChatState,
  MAX_CONTEXT_MESSAGES,
  messagesForRequest,
  scanSse,
  settleMessage,
  type ChatMessage,
} from "./model"

const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "m1",
  role: "user",
  text: "ciao",
  at: 1,
  ...over,
})

const event = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n`

describe("scanSse", () => {
  test("decodes complete events", () => {
    const scan = scanSse(`${event("Ciao")}${event(" mondo")}`)
    expect(scan.deltas).toEqual(["Ciao", " mondo"])
    expect(scan.rest).toBe("")
    expect(scan.done).toBe(false)
  })

  test("holds a partial line back instead of dropping it", () => {
    // The regression this guards: a chunk boundary lands mid-JSON, which TCP
    // does routinely. A decoder that parses per-chunk loses exactly the tokens
    // that straddle the boundary, and it reads as a model swallowing words.
    const whole = event("parola")
    const cut = Math.floor(whole.length / 2)

    const first = scanSse(whole.slice(0, cut))
    expect(first.deltas).toEqual([])
    expect(first.rest).toBe(whole.slice(0, cut))

    const second = scanSse(first.rest + whole.slice(cut))
    expect(second.deltas).toEqual(["parola"])
    expect(second.rest).toBe("")
  })

  test("reports the terminator", () => {
    const scan = scanSse(`${event("fine")}data: [DONE]\n`)
    expect(scan.deltas).toEqual(["fine"])
    expect(scan.done).toBe(true)
  })

  test("skips comments, keep-alives and frames it cannot parse", () => {
    const scan = scanSse(`: keep-alive\n\n${event("ok")}data: {non json}\n`)
    expect(scan.deltas).toEqual(["ok"])
    expect(scan.done).toBe(false)
  })

  test("ignores an event with no content, such as a role-only opener", () => {
    const scan = scanSse(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n`)
    expect(scan.deltas).toEqual([])
  })
})

describe("messagesForRequest", () => {
  test("sends role and content, oldest first", () => {
    const state = [message({ id: "a", text: "domanda" }), message({ id: "b", role: "assistant", text: "risposta" })]
    expect(messagesForRequest(state)).toEqual([
      { role: "user", content: "domanda" },
      { role: "assistant", content: "risposta" },
    ])
  })

  test("drops a failed turn rather than sending an empty assistant message", () => {
    const state = [
      message({ id: "a", text: "domanda" }),
      message({ id: "b", role: "assistant", text: "", error: "rete non raggiungibile" }),
      message({ id: "c", text: "riprova" }),
    ]
    expect(messagesForRequest(state).map((m) => m.content)).toEqual(["domanda", "riprova"])
  })

  test("drops a message that is only whitespace", () => {
    const state = [message({ id: "a", text: "   " }), message({ id: "b", text: "vera" })]
    expect(messagesForRequest(state).map((m) => m.content)).toEqual(["vera"])
  })

  test("keeps only the most recent window", () => {
    const many = Array.from({ length: 40 }, (_, i) => message({ id: `m${i}`, text: `riga ${i}` }))
    const sent = messagesForRequest(many, 4)
    expect(sent).toHaveLength(4)
    expect(sent[0].content).toBe("riga 36")
    expect(sent[3].content).toBe("riga 39")
  })

  test("the default window is bounded", () => {
    const many = Array.from({ length: 200 }, (_, i) => message({ id: `m${i}`, text: `riga ${i}` }))
    expect(messagesForRequest(many)).toHaveLength(MAX_CONTEXT_MESSAGES)
  })
})

describe("settleMessage", () => {
  test("an error arriving mid-stream keeps what already streamed", () => {
    // Half an answer plus a reason beats either alone, and discarding the text
    // would make a flaky network look like a model that refuses to answer.
    let state = appendMessage(createChatState(), message({ id: "r", role: "assistant", text: "", streaming: true }))
    state = appendDelta(state, "r", "Ecco la prima")
    state = settleMessage(state, "r", "la connessione si è interrotta")

    expect(state.messages[0].text).toBe("Ecco la prima")
    expect(state.messages[0].error).toBe("la connessione si è interrotta")
    expect(state.messages[0].streaming).toBe(false)
  })

  test("a clean finish carries no error", () => {
    let state = appendMessage(
      createChatState(),
      message({ id: "r", role: "assistant", text: "fatto", streaming: true }),
    )
    state = settleMessage(state, "r")
    expect(state.messages[0].error).toBeUndefined()
    expect(state.messages[0].streaming).toBe(false)
  })
})

describe("conversationTitle", () => {
  test("uses the first question", () => {
    expect(conversationTitle([message({ text: "come funziona il parser" })])).toBe("come funziona il parser")
  })

  test("ignores an assistant message that came first", () => {
    const state = [message({ id: "a", role: "assistant", text: "Ciao!" }), message({ id: "b", text: "domanda vera" })]
    expect(conversationTitle(state)).toBe("domanda vera")
  })

  test("collapses whitespace and truncates", () => {
    expect(conversationTitle([message({ text: "una  domanda\nmolto lunga davvero" })], 12)).toBe("una domanda…")
  })

  test("names an empty conversation", () => {
    expect(conversationTitle([])).toBe("Nuova conversazione")
  })
})

// ---------------------------------------------------------------------------
// C3: Models, pricing, agents, and ADE Test filtering
// ---------------------------------------------------------------------------

import {
  agentsFromList,
  defaultAgentChoice,
  defaultModelChoice,
  fallbackModels,
  formatModelLabel,
  formatModelPrice,
  isFreeModel,
  modelsFromProviderList,
  validateSelectedModel,
} from "./model"
import type { ProviderList, Agent } from "@nikcli-ai/sdk/client"

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
    openrouter: "openai/gpt-6-astra-pro", // Note from Dario: default OpenRouter is paid!
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
    expect(formatModelPrice({ input: 0, output: 0 }, true, "it")).toBe("gratis")
    expect(formatModelLabel("Gemini Flash", { input: 0, output: 0 }, true, "it")).toBe("Gemini Flash (gratis)")
  })

  test("formats free models in English as free", () => {
    expect(formatModelPrice({ input: 0, output: 0 }, true, "en")).toBe("free")
    expect(formatModelLabel("Gemini Flash", { input: 0, output: 0 }, true, "en")).toBe("Gemini Flash (free)")
  })

  test("formats paid models with input and output $/M tokens", () => {
    expect(formatModelPrice({ input: 3, output: 15 }, false, "it")).toBe("$3/$15 /M")
    expect(formatModelLabel("Claude Sonnet", { input: 3, output: 15 }, false, "it")).toBe("Claude Sonnet ($3/$15 /M)")
  })

  test("formats paid models with equal input and output price", () => {
    expect(formatModelPrice({ input: 5, output: 5 }, false, "it")).toBe("$5/M")
  })
})

describe("modelsFromProviderList (C3)", () => {
  test("in standard mode includes all active models with price labels", () => {
    const models = modelsFromProviderList(mockProviderList, { isTest: false, lang: "it" })
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
    const testModels = modelsFromProviderList(mockProviderList, { isTest: true, lang: "it" })
    expect(testModels.length).toBe(3)
    // Every single model in ADE Test must be free!
    expect(testModels.every((m) => m.free)).toBe(true)

    // Paid models must be absent in ADE Test!
    expect(testModels.some((m) => m.id === "openai/gpt-6-astra-pro")).toBe(false)
    expect(testModels.some((m) => m.id === "anthropic/claude-sonnet-4.5")).toBe(false)
  })

  test("in English uses 'free' instead of 'gratis'", () => {
    const models = modelsFromProviderList(mockProviderList, { isTest: true, lang: "en" })
    const freeModel = models.find((m) => m.id === "google/gemini-2.5-flash:free")
    expect(freeModel?.label).toContain("(free)")
  })

  test("returns fallback free models when provider list is null or empty", () => {
    const models = modelsFromProviderList(null, { isTest: true })
    expect(models.length).toBeGreaterThan(0)
    expect(models.every((m) => m.free)).toBe(true)
  })
})

describe("defaultModelChoice (C3)", () => {
  test("in ADE Test mode the default model is NEVER paid", () => {
    const testModels = modelsFromProviderList(mockProviderList, { isTest: true })
    const choice = defaultModelChoice(testModels, mockProviderList, { isTest: true })
    expect(choice).toBeDefined()
    expect(choice!.free).toBe(true)
    expect(choice!.id).toBe("google/gemini-2.5-flash:free")
  })

  test("in normal mode default is nikcli's default, NEVER server's paid default (A1 / Dario note)", () => {
    const models = modelsFromProviderList(mockProviderList, { isTest: false })
    const choice = defaultModelChoice(models, mockProviderList, { isTest: false })
    expect(choice).toBeDefined()
    // It must pick nikcli's default ("google/gemini-2.5-flash:free"), NOT OpenRouter's paid default ("openai/gpt-6-astra-pro")!
    expect(choice!.id).toBe("google/gemini-2.5-flash:free")
    expect(choice!.id).not.toBe("openai/gpt-6-astra-pro")
  })

  test("fallback models default is also free", () => {
    const fallback = fallbackModels(true)
    const choice = defaultModelChoice(fallback, null, { isTest: true })
    expect(choice?.free).toBe(true)
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
})

describe("validateSelectedModel (C3)", () => {
  const models = modelsFromProviderList(mockProviderList, { isTest: false })

  test("allows paid model in standard mode when explicitly chosen", () => {
    expect(validateSelectedModel("anthropic/claude-sonnet-4.5", models, false)).toBe("anthropic/claude-sonnet-4.5")
  })

  test("rejects paid model in ADE Test mode even if stored in localStorage", () => {
    // Crucial safety guarantee: even if localStorage had a paid model from before,
    // in ADE Test it is refused and falls back to safe free default.
    expect(validateSelectedModel("anthropic/claude-sonnet-4.5", models, true)).toBeUndefined()
  })

  test("accepts free model in ADE Test mode", () => {
    expect(validateSelectedModel("google/gemini-2.5-flash:free", models, true)).toBe("google/gemini-2.5-flash:free")
  })
})
