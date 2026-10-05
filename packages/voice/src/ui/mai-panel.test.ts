import { describe, expect, test } from "bun:test"
import { t } from "@nikcli-ai/ade/i18n"
import { maiCapped, maiOfferShown, maiRetryShown, maiSpendText, maiStatusText, type MaiPanelInput } from "./mai-panel"
import { MAI_DAILY_CAP_USD } from "../tts/mai"

const today = { day: "2026-10-05", calls: 0, cost: 0 }
const base: MaiPanelInput = { replyVoice: "it-IT-Rosa", hasKey: true, testIdentity: false, spend: today }

describe("il pannello MAI", () => {
  test("la domanda una tantum: su Ugo con la chiave, mai senza chiave, mai in ADE Test, mai dopo una risposta", () => {
    const ugo = { ...base, replyVoice: "ugo" as const }
    expect(maiOfferShown(ugo)).toBe(true)
    expect(maiOfferShown({ ...ugo, hasKey: false })).toBe(false)
    expect(maiOfferShown({ ...ugo, testIdentity: true })).toBe(false)
    expect(maiOfferShown({ ...ugo, replyVoiceOffer: "declined" })).toBe(false)
    expect(maiOfferShown(base)).toBe(false)
  })

  test("dopo un 402 c'è «Riprova MAI»; dopo un 429 no, si riapre da solo", () => {
    expect(maiRetryShown(base)).toBe(false)
    expect(maiRetryShown({ ...base, blocked: "payment" })).toBe(true)
    for (const kind of ["unauthorized", "bad-request", "forbidden", "unavailable"] as const) {
      expect(maiRetryShown({ ...base, blocked: kind })).toBe(true)
    }
    expect(maiRetryShown({ ...base, blocked: "rate-limited" })).toBe(false)
    expect(maiRetryShown({ ...base, blocked: "transient" })).toBe(false)
  })

  test("lo stato dice chiave, ripiego e motivo", () => {
    expect(maiStatusText(base)).toBe(t("vui.mai.status.active"))
    expect(maiStatusText({ ...base, hasKey: false })).toBe(t("vui.mai.status.noKey"))
    expect(maiStatusText({ ...base, testIdentity: true })).toBe(t("vui.mai.status.test"))
    expect(maiStatusText({ ...base, replyVoice: "ugo" })).toBe(t("vui.mai.status.notChosen"))
    expect(maiStatusText({ ...base, blocked: "payment" })).toBe(
      t("vui.mai.status.fallback", t("vui.mai.reason.payment")),
    )
    expect(maiStatusText({ ...base, blocked: "unauthorized" })).toBe(
      t("vui.mai.status.fallback", t("vui.mai.reason.unauthorized")),
    )
    expect(maiStatusText({ ...base, blocked: "timeout" })).toBe(t("vui.mai.status.fallback", t("vui.mai.reason.other")))
  })

  test("il tetto raggiunto è un ripiego anche senza una chiusura del breaker", () => {
    const spent = { ...today, replyCost: MAI_DAILY_CAP_USD, replyCalls: 40 }
    expect(maiCapped(spent)).toBe(true)
    expect(maiStatusText({ ...base, spend: spent })).toBe(t("vui.mai.status.fallback", t("vui.mai.reason.cap")))
  })

  test("la spesa del giorno è la parte delle risposte, contro il tetto", () => {
    const spent = { ...today, calls: 12, cost: 0.4, replyCalls: 8, replyCost: 0.12 }
    const it = maiSpendText(spent, "it")
    expect(it).toContain("0,12")
    expect(it).toContain("0,50")
    expect(it).toContain("8")
    expect(it).not.toContain("0,40")
    expect(maiSpendText(spent, "en")).toContain("0.12")
  })
})
