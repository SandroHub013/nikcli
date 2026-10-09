import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/*
 * Brief ragu-via-servizi-nik, package C (review of package A, B9): the web app and the desktop app signed in with
 * Nik's account: OAuth at auth.nikcli-ai.dev (account-oauth.ts), the token then sent to the connected server. It goes,
 * as on the phone. What stays is the connected server's own accounts: email and password, sign up on an empty server.
 */
const PACKAGES = path.join(import.meta.dir, "../../..")
const exists = (file: string) => fs.existsSync(path.join(PACKAGES, file))
const read = (file: string) => fs.readFileSync(path.join(PACKAGES, file), "utf8")

describe("the web and desktop apps without Nik's account", () => {
  test("no OAuth client for Nik's issuer", () => {
    expect(exists("app/src/context/account-oauth.ts")).toBe(false)
    const account = read("app/src/context/account.tsx")
    expect(account).not.toMatch(/loginWithOAuth|OAuthTokens|account-oauth|auth\.nikcli/)
    expect(read("desktop/src/shell.tsx")).not.toMatch(/loginWithOAuth|oauthLogin/)
    expect(read("desktop/src/i18n/en.ts")).not.toMatch(/desktop\.account\.oauth|legacyDivider/)
  })

  test("the server's own accounts stay", () => {
    const account = read("app/src/context/account.tsx")
    expect(account).toContain('request("/user/login"')
    expect(account).toContain('request("/user/register"')
    expect(read("desktop/src/shell.tsx")).toContain("account.login(")
  })
})
