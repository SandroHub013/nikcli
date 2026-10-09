import { describe, expect, it } from "bun:test"
import { validateChatBody } from "../src/middleware/validation"

describe("validateChatBody", () => {
  it("accepts minimal valid body", () => {
    const r = validateChatBody({
      model: "kimi-k2.6",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(r.ok).toBe(true)
  })

  it("rejects empty messages", () => {
    const r = validateChatBody({ model: "kimi-k2.6", messages: [] })
    expect(r.ok).toBe(false)
  })

  it("rejects missing model", () => {
    const r = validateChatBody({ messages: [{ role: "user", content: "hi" }] })
    expect(r.ok).toBe(false)
  })

  it("rejects out-of-range temperature", () => {
    const r = validateChatBody({
      model: "kimi-k2.6",
      messages: [{ role: "user", content: "hi" }],
      temperature: 3,
    })
    expect(r.ok).toBe(false)
  })

  it("accepts ragu envelope", () => {
    const r = validateChatBody({
      model: "kimi-k2.6",
      messages: [{ role: "user", content: "hi" }],
      ragu: { cache: true, preferProvider: "groq" },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.ragu?.preferProvider).toBe("groq")
  })

  it("accepts tools array", () => {
    const r = validateChatBody({
      model: "kimi-k2.6",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "search", parameters: { type: "object" } } }],
    })
    expect(r.ok).toBe(true)
  })
})
