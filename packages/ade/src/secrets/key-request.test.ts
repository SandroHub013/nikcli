import { describe, expect, test } from "bun:test"
import { t } from "../i18n"
import { KEY_REASON_MAX, keyRequestAgents, keyRequestText } from "./keys"

/*
 * Review of review-alti, 1.3: `@ade keys ask` needs no yes before its dialog,
 * which is already the question; the dialog must say who asks, give the
 * reason as the agent's words, and say where the key goes.
 */

const label = (id: string) => ({ "claude-code": "Claude Code", nikcli: "nikcli" })[id] ?? id
const ASKER = { title: "Sessione 2 — Claude Code", agentId: "claude-code" }

describe("the key request dialog (keys ask)", () => {
  test("names the pane and the agent that ask, and says the key goes to that agent", () => {
    const text = keyRequestText({ env: "OPENAI_API_KEY", reason: "per i test di integrazione", asker: ASKER, agentLabel: label })
    expect(text.title).toBe(t("keys.request.from", "Sessione 2 — Claude Code", "Claude Code", "OPENAI_API_KEY"))
    expect(text.title).toContain("Sessione 2 — Claude Code")
    expect(text.title).toContain("OPENAI_API_KEY")
    expect(text.goes).toBe(t("keys.request.goes", "Claude Code"))
    expect(text.says).toBe("per i test di integrazione")
  })

  test("the reason is the agent's text: no control characters, and cut short", () => {
    const text = keyRequestText({ env: "X_KEY", reason: `riga\u0007\ndue\r\n${"a".repeat(1000)}`, asker: ASKER, agentLabel: label })
    expect(text.says).not.toMatch(/[\u0000-\u001f]/)
    expect(text.says!.startsWith("riga due ")).toBe(true)
    expect(text.says!.length).toBe(KEY_REASON_MAX)
    expect(text.says!.endsWith("…")).toBe(true)
  })

  test("no reason, nothing said for the agent; no known sender, the old wording", () => {
    const bare = keyRequestText({ env: "X_KEY", reason: "  ", agentLabel: label })
    expect(bare.says).toBeUndefined()
    expect(bare.title).toBe(t("keys.request.title", "X_KEY"))
    expect(bare.goes).toBe(t("keys.request.hint"))
  })

  test("the key is given to the asking agent, added to the ones it already has", () => {
    expect(keyRequestAgents(undefined, ASKER)).toEqual(["claude-code"])
    expect(keyRequestAgents(["codex"], ASKER)).toEqual(["codex", "claude-code"])
    expect(keyRequestAgents(["claude-code"], ASKER)).toEqual(["claude-code"])
    expect(keyRequestAgents(["codex"], undefined)).toEqual(["codex"])
  })
})
