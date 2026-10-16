import { describe, expect, test } from "bun:test"
import { en } from "../i18n/en"
import { it } from "../i18n/it"

/*
 * The words of the approvals (choice 4, with the words of choice 6): the same in Italian and in English, the same
 * «Sempre», «Consenti» and «Nega» as the bot's card, and none of the technical words the user was spared.
 */
const KEYS = Object.keys(it).filter(
  (key) =>
    key.startsWith("bots.waiting.") ||
    key.startsWith("bots.permissions.always") ||
    key === "gateway.approve.byAdeOnce" ||
    key === "gateway.approve.byAdeNo" ||
    key === "gateway.panel.rejectQuestion",
)

const say = (catalog: Record<string, unknown>, key: string) => {
  const entry = catalog[key]
  return typeof entry === "function" ? String((entry as (...a: string[]) => string)("A", "B", "C")) : String(entry)
}

describe("the words of the approvals", () => {
  test("there are some, and each is in both languages", () => {
    expect(KEYS.length).toBeGreaterThan(14)
    for (const key of KEYS) {
      expect(key in en, key).toBe(true)
      expect(say(it, key).length, key).toBeGreaterThan(0)
      expect(say(en, key).length, key).toBeGreaterThan(0)
    }
  })

  test("English has English quotes, Italian has its own; no sentence begins or ends like a piece", () => {
    for (const key of KEYS) {
      expect(say(en, key), key).not.toMatch(/[«»]/)
      for (const value of [say(it, key), say(en, key)]) expect(value, key).not.toMatch(/(^[ ,;:.])|( $)/)
    }
  })

  test("none of the words the user was spared: gateway, runner, token, persona", () => {
    for (const key of KEYS) {
      expect(say(it, key), key).not.toMatch(/gateway|runner|\btoken\b|persona/i)
      expect(say(en, key), key).not.toMatch(/gateway|runner|\btoken\b|persona/i)
    }
  })

  test("the same «Sempre», «Consenti» and «Nega» as the card of a question", () => {
    expect(say(it, "bots.permissions.always")).toContain("«Sempre»")
    expect(say(it, "bots.permissions.panelTextRagu")).toContain("Consenti, Nega o «Sempre per questo bot»")
    expect(it["bots.permission.allow"]).toBe("Consenti")
    expect(it["bots.permission.deny"]).toBe("Nega")
    expect(say(it, "bots.waiting.title")).toBe("Aspettano te")
    // «aspetta te», as a room member waiting for the user says (D23).
    expect(say(it, "bots.waiting.notice")).toContain(say(it, "bots.room.needsYou"))
  })
})
