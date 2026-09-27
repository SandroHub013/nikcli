import { afterEach, describe, expect, test } from "bun:test"
import type { Message } from "@nikcli-ai/sdk/httpapi"
import { setLocalePreference } from "../i18n/locale"
import { modelsFromProviderList } from "./model"
import { answerUsage, answerUsageText, formatCost, sessionUsage, sessionUsageText } from "./usage"

/* C7: what each answer and the session cost, as the server wrote it. */

const question = (id: string) => ({ id, sessionID: "ses_1", role: "user", time: { created: 1 } }) as unknown as Message

const answer = (
  id: string,
  cost: number,
  tokens: { input: number; output: number; total?: number },
  completed = true,
) =>
  ({
    id,
    sessionID: "ses_1",
    role: "assistant",
    time: completed ? { created: 2, completed: 3 } : { created: 2 },
    providerID: "openrouter",
    modelID: "a/b:free",
    cost,
    tokens: { ...tokens, reasoning: 0, cache: { read: 0, write: 0 } },
  }) as unknown as Message

afterEach(() => setLocalePreference("it"))

describe("the chat's cost and tokens", () => {
  test("an answer shows its tokens and cost once finished; a question or an answer still coming shows none", () => {
    setLocalePreference("en")
    expect(answerUsage(question("m1"))).toBeUndefined()
    expect(answerUsage(answer("m2", 0.0021, { input: 1200, output: 34 }, false))).toBeUndefined()
    const usage = answerUsage(answer("m2", 0.0021, { input: 1200, output: 34 }))!
    expect(usage).toEqual({ cost: 0.0021, tokens: 1234 })
    expect(answerUsageText(usage)).toBe("1,234 tokens · $0.0021")
  })

  test("the server's total wins over the sum, and an answer that used nothing shows nothing", () => {
    expect(answerUsage(answer("m1", 0, { input: 10, output: 5, total: 40 }))?.tokens).toBe(40)
    expect(answerUsage(answer("m2", 0, { input: 0, output: 0 }))).toBeUndefined()
  })

  test("a session costs the sum of its answers; its context is the last answer that used tokens", () => {
    const messages = [
      question("m1"),
      answer("m2", 0.5, { input: 1000, output: 200 }),
      question("m3"),
      answer("m4", 0.25, { input: 3000, output: 100 }),
      answer("m5", 0, { input: 0, output: 0 }),
    ]
    const usage = sessionUsage(messages)
    expect(usage.cost).toBe(0.75)
    expect(usage.context).toEqual({ tokens: 3100, providerID: "openrouter", modelID: "a/b:free" })
    setLocalePreference("en")
    expect(sessionUsageText(usage)).toBe("Session: $0.75 · context 3,100 tokens")
    expect(sessionUsageText(usage, 10_000)).toBe("Session: $0.75 · context 3,100 tokens (31% of the model's window)")
    expect(sessionUsageText(sessionUsage([question("m1")]))).toBe("Session: $0.00")
  })

  test("in Italian too", () => {
    setLocalePreference("it")
    const usage = answerUsage(answer("m2", 0.0021, { input: 1200, output: 34 }))!
    // Italian groups thousands from five digits on (CLDR): 1234, 12.345.
    expect(answerUsageText(usage)).toMatch(/^1234 token · 0,0021\s(USD|\$)$/)
    expect(answerUsageText({ cost: 0, tokens: 12345 })).toMatch(/^12\.345 token/)
    expect(sessionUsageText(sessionUsage([answer("m2", 1.5, { input: 500, output: 0 })]), 1000)).toMatch(
      /^Sessione: 1,50\s(USD|\$) · contesto 500 token \(50% della finestra del modello\)$/,
    )
  })

  test("a cost too small for four decimals is not shown as zero", () => {
    setLocalePreference("en")
    expect(formatCost(0.00001)).toBe("< $0.0001")
    expect(formatCost(0)).toBe("$0.00")
    expect(formatCost(12.3456)).toBe("$12.35")
  })

  test("the catalog carries each model's window, when the provider gives it", () => {
    const models = modelsFromProviderList({
      all: [
        {
          id: "openrouter",
          name: "OpenRouter",
          models: {
            "a/b:free": {
              id: "a/b:free",
              name: "B",
              cost: { input: 0, output: 0 },
              limit: { context: 131072, output: 8192 },
            },
            "c/d:free": { id: "c/d:free", name: "D", cost: { input: 0, output: 0 } },
          },
        },
      ],
    } as never)
    expect(models.find((m) => m.modelID === "a/b:free")?.context).toBe(131072)
    expect(models.find((m) => m.modelID === "c/d:free")?.context).toBeUndefined()
  })
})
