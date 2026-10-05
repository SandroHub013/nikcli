import { describe, expect, test } from "bun:test"
import type { KeyInfo } from "./keys"
import { watchKeychain, XAI_KEY_ENV, xaiKeyChanged, xaiKeyDraft, xaiKeyEntry, xaiKeyUse } from "./xai-key"

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

describe("quando la chiave xAI cambia", () => {
  const recorder = () => {
    const calls: string[] = []
    const effects = {
      retryStream: () => calls.push("retry"),
      markReady: () => calls.push("ready"),
      cancelSocket: () => calls.push("cancel"),
      refresh: () => calls.push("refresh"),
    }
    return { calls, effects }
  }

  test("una chiave nuova toglie il rifiuto e si rilegge", () => {
    const { calls, effects } = recorder()
    xaiKeyChanged("saved", effects)
    expect(calls).toEqual(["retry", "ready", "refresh"])
  })

  test("una chiave tolta chiude il socket e poi toglie la pausa che la chiusura lascerebbe (T5b, B1)", () => {
    const { calls, effects } = recorder()
    xaiKeyChanged("removed", effects)
    expect(calls).toEqual(["cancel", "retry", "ready", "refresh"])
  })

  test("con le impostazioni aperte il portachiavi si rilegge quando la finestra torna davanti, e a intervalli (T5b, B3)", async () => {
    const target = new EventTarget()
    let reads = 0
    const stop = watchKeychain(() => reads++, target as unknown as Window, 20)
    target.dispatchEvent(new Event("focus"))
    expect(reads).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 70))
    expect(reads).toBeGreaterThanOrEqual(2)
    stop()
    const after = reads
    target.dispatchEvent(new Event("focus"))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(reads).toBe(after)
  })
})
