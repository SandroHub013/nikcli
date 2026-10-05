import { describe, expect, test } from "bun:test"
import type { KeyInfo } from "./keys"
import { XAI_KEY_ENV, xaiKeyDraft, xaiKeyEntry, xaiKeyUse } from "./xai-key"

const key = (name: string, env: string, agents: string[] = []): KeyInfo =>
  ({ name, env, agents, masked: "••••0000", createdMs: 0 }) as KeyInfo

describe("la chiave xAI nel portachiavi", () => {
  test("la voce è quella con XAI_API_KEY, qualunque nome abbia", () => {
    expect(xaiKeyEntry([key("OpenRouter", "OPENROUTER_API_KEY"), key("Grok", XAI_KEY_ENV)])?.name).toBe("Grok")
    expect(xaiKeyEntry([key("xAI", "OTHER_KEY")])).toBeUndefined()
  })

  test("una nuova si chiama «xAI», per nessun agente; un «xAI» già di un'altra variabile non si tocca", () => {
    expect(xaiKeyDraft([], " xai-finta ")).toEqual({ name: "xAI", env: XAI_KEY_ENV, agents: [], value: "xai-finta" })
    expect(xaiKeyDraft([key("xAI", "OTHER_KEY")], "v").name).toBe("xAI 2")
  })

  test("sopra una esistente tiene il suo nome e i suoi agenti", () => {
    expect(xaiKeyDraft([key("Grok", XAI_KEY_ENV, ["opencode"])], "v")).toEqual({
      name: "Grok",
      env: XAI_KEY_ENV,
      agents: ["opencode"],
      value: "v",
    })
  })

  test("usata dallo streaming, rifiutata, o ferma perché trascrive MAI-Transcribe-2", () => {
    expect(xaiKeyUse({ streaming: true, refused: false })).toBe("used")
    expect(xaiKeyUse({ streaming: true, refused: true })).toBe("refused")
    expect(xaiKeyUse({ streaming: false, refused: false })).toBe("idle")
  })
})
