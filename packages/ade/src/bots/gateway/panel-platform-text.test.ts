import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { it } from "../../i18n/it"
import { en } from "../../i18n/en"
import { codeOf } from "../../test-support/source-text"

/*
 * «Chi può scrivere» and the remote commands said Telegram on every platform.
 * The panel is a `.tsx` bun test cannot import: its wiring is read from the
 * source, and the texts from both catalogs.
 */
const panel = readFileSync(join(import.meta.dir, "panel.tsx"), "utf8")
const KEYS = ["gateway.panel.nobody", "gateway.panel.remoteOn", "gateway.panel.remoteWhat"] as const

describe("the gateway panel speaks of the platform it shows", () => {
  test("lint: every gateway panel text is picked by the platform shown, with that platform's own wording", () => {
    for (const key of KEYS)
      expect(codeOf(panel)).toContain(codeOf(`said(t("${key}"), t("${key}Discord"), t("${key}Slack"))`))
  })

  test("Telegram's «nobody» points to the QR below it, not to a code: the code is the reserve (choice 3)", () => {
    expect(it["gateway.panel.nobody"]).toBe("Nessuno ancora: abbina il tuo account qui sotto.")
    expect(en["gateway.panel.nobody"]).toBe("Nobody yet: pair your account below.")
    // The QR sits below the line, in the same step, and the code is told as the reserve under it.
    expect(panel.indexOf('t("gateway.panel.nobody")')).toBeLessThan(panel.indexOf("<PairLink"))
    expect(String(it["gateway.panel.linkFallback"])).toContain("codice")
  })

  test("Discord's and Slack's never send you to Telegram, in either language", () => {
    for (const catalog of [it, en] as Record<string, unknown>[]) {
      for (const key of KEYS) {
        const discord = String(catalog[`${key}Discord`])
        const slack = String(catalog[`${key}Slack`])
        expect([key, discord.includes("Discord"), discord.includes("Telegram")]).toEqual([key, true, false])
        expect([key, slack.includes("Slack"), slack.includes("Telegram")]).toEqual([key, true, false])
      }
    }
  })

  test("lint: shows attention box with retry and change code buttons when needsAttention", () => {
    expect(panel).toContain('data-slot="gateway-attention-box"')
    expect(panel).toContain("onClick={() => void panel.retry()}")
    expect(panel).toContain('onClick={() => setPicked("paste")}')
    expect(panel).toContain('t("gateway.panel.retry")')
    expect(panel).toContain('t("gateway.panel.changeCode")')
  })
})
