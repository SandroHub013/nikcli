import { describe, expect, test } from "bun:test"
import { framingBlocked } from "./handshake"
import { canOpenExternally, forgetMessage, forgetSite, probeFraming, readHeaders } from "./host-bridge"
import type { ForgetReport } from "./host-bridge"
import { CATALOGS } from "../i18n"

const report = (over: Partial<ForgetReport> = {}): ForgetReport => ({
  storageCleared: false,
  storageUnverified: false,
  cookiesDeleted: 0,
  cookiesReadable: true,
  ...over,
})

/** The line the pane would show, in one language. */
function said(catalog: Record<string, unknown>, input: ForgetReport): string {
  const message = forgetMessage(input)
  const entry = catalog[message.key]
  if (entry === undefined) throw new Error(`manca la voce ${message.key}`)
  return typeof entry === "function" ? String((entry as (n: number) => string)(message.cookies)) : String(entry)
}

describe("host bridge", () => {
  test("the host's headers are read the way framingBlocked reads a response", () => {
    expect(framingBlocked(readHeaders({ xFrameOptions: "SAMEORIGIN", csp: null }))).toBe(true)
    expect(framingBlocked(readHeaders({ xFrameOptions: null, csp: "frame-ancestors 'self'" }))).toBe(true)
    expect(framingBlocked(readHeaders({ xFrameOptions: null, csp: "default-src *" }))).toBe(false)
    expect(framingBlocked(readHeaders(undefined))).toBe(false)
  })

  test("outside the desktop app there is no probe and no system browser", async () => {
    expect(await probeFraming("https://a.test/")).toBeUndefined()
    expect(canOpenExternally()).toBe(false)
    expect(await forgetSite("https://a.test/")).toEqual({ error: "non disponibile fuori dall'app" })
  })

  test("the message never claims a deletion that did not happen", () => {
    /*
     * The rule this file exists for. «Dimentica questo sito» used to say
     * "Storage e cookie cancellati" whenever the call to the host returned,
     * and the site's localStorage was still there after a reload. So: the
     * message may say the storage is gone only when the host read it back
     * empty, and may count cookies only when it deleted some.
     */
    const cases: ForgetReport[] = [
      report(),
      report({ storageCleared: true }),
      report({ storageCleared: true, cookiesDeleted: 1 }),
      report({ storageCleared: true, cookiesDeleted: 4 }),
      report({ storageCleared: true, cookiesReadable: false }),
      report({ storageUnverified: true }),
      report({ storageUnverified: true, cookiesDeleted: 2 }),
      report({ cookiesDeleted: 3 }),
    ]

    for (const catalog of Object.values(CATALOGS)) {
      for (const input of cases) {
        const line = said(catalog as Record<string, unknown>, input)
        const claimsStorageGone = /(storage[^.;]*\b(cancellat|gone|cleared)|(cancellat|cleared)[^.;]*storage)/i.test(line)
        expect([JSON.stringify(input), claimsStorageGone]).toEqual([JSON.stringify(input), input.storageCleared])
        if (input.cookiesDeleted === 0) expect(line).not.toMatch(/\b(\d+ cookie|un cookie|one cookie)\b/i)
        else expect(line).toMatch(new RegExp(`\\b(${input.cookiesDeleted}|un|one) cookie`, "i"))
        // An unverified deletion has to say so, in both languages.
        if (input.storageUnverified) expect(line).toMatch(/(verific|check)/i)
      }
    }
  })

  test("nothing deleted is reported as nothing, and it is not an error", () => {
    expect(forgetMessage(report())).toEqual({ key: "browser.forget.done.none", ok: false, cookies: 0 })
    expect(forgetMessage(report({ storageUnverified: true })).ok).toBe(false)
    expect(forgetMessage(report({ storageCleared: true })).ok).toBe(true)
  })
})
