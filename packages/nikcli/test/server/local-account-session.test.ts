import { preserveTestEnv } from "../helpers/env"
import { removeTestDir } from "../helpers/fs"
import { afterAll, describe, expect, it } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { SignJWT } from "jose"

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-local-account-home-"))
process.env.NIKCLI_TEST_HOME = testHome
process.env.NIKCLI_TEST_MODE = "1"
process.env.NIKCLI_DISABLE_MODELS_FETCH = "1"
process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1"
// Deliberately *not* NIKCLI_REQUIRE_OAUTH: this is the default desktop shape,
// where the terminal talks to an in-process server with no password set.
process.env.NIKCLI_AUTH_ISSUER = "https://auth.test"
process.env.NIKCLI_AUTH_AUDIENCE = "nikcli-api"
process.env.NIKCLI_AUTH_JWT_SECRET = "test-secret-that-is-long-enough-for-hs256"
process.env.XDG_DATA_HOME = path.join(testHome, "data")
process.env.XDG_CACHE_HOME = path.join(testHome, "cache")
process.env.XDG_CONFIG_HOME = path.join(testHome, "config")
process.env.XDG_STATE_HOME = path.join(testHome, "state")

preserveTestEnv([
  "NIKCLI_TEST_HOME",
  "NIKCLI_TEST_MODE",
  "NIKCLI_DISABLE_MODELS_FETCH",
  "NIKCLI_DISABLE_PROJECT_CONFIG",
  "NIKCLI_AUTH_ISSUER",
  "NIKCLI_AUTH_AUDIENCE",
  "NIKCLI_AUTH_JWT_SECRET",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
])
for (const dir of ["data", "cache", "config", "state"]) {
  await fs.mkdir(path.join(testHome, dir), { recursive: true })
}

const { Instance } = await import("@/project/instance")
const { Server } = await import("@/server/server")
const { Auth } = await import("@/server/httpapi/auth")
const { AccountRepo } = await import("@/account/repo")

const ACCOUNT_ID = "acc_localsession"
const EMAIL = "owner@example.com"

function jwt(expiresInSeconds: number) {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ email: EMAIL, client_id: "nikcli" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("https://auth.test")
    .setAudience("nikcli-api")
    .setSubject(ACCOUNT_ID)
    .setIssuedAt(now)
    .setExpirationTime(now + expiresInSeconds)
    .sign(new TextEncoder().encode(process.env.NIKCLI_AUTH_JWT_SECRET!))
}

/** As the TUI calls it: in-process, no socket, bearer read from the token file. */
function request(pathname: string, token?: string) {
  return Server.fetch(
    new Request(`http://nikcli.local${pathname}`, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    }),
  )
}

afterAll(async () => {
  await Instance.disposeAll().catch(() => undefined)
  await removeTestDir(testHome)
})

/**
 * The terminal's stored bearer is a snapshot of a fifteen-minute issuer token,
 * while the account row beside it refreshes itself. Once the snapshot aged out,
 * `/user/me` answered 401, the TUI read "signed out" and opened the sign-in
 * dialog on every launch for someone who had never signed out.
 */
describe("local account session", () => {
  it("reports no session when the machine has no account", async () => {
    expect((await request("/user/me", await jwt(-60))).status).toBe(401)
    expect((await request("/user/me")).status).toBe(401)
  })

  it("answers /user/me from the machine's account when the caller's token expired", async () => {
    AccountRepo.persistAccount(ACCOUNT_ID, EMAIL, "https://auth.test", await jwt(900), "refresh-token" as never, 900)

    const response = await request("/user/me", await jwt(-60))
    expect(response.status).toBe(200)
    expect(((await response.json()) as { email: string }).email).toBe(EMAIL)
  })

  it("answers /user/me with no bearer at all", async () => {
    const response = await request("/user/me")
    expect(response.status).toBe(200)
    expect(((await response.json()) as { email: string }).email).toBe(EMAIL)
  })

  it("reports the active account to /account with an expired bearer", async () => {
    const response = await request("/account", await jwt(-60))
    expect(response.status).toBe(200)
    expect(((await response.json()) as { email: string } | null)?.email).toBe(EMAIL)
  })

  it("never falls back for a request that crossed a socket", async () => {
    // `Auth.markLocal` is the whole gate, and only `ServerRouter` sets it — for
    // requests it is handed without a `Bun.Server`. An unmarked request is one
    // that came off the wire, and it gets the pre-existing answer: nothing.
    const remote = new Request("http://nikcli.local/user/me")
    expect(Auth.isLocal(remote)).toBe(false)
    expect(await Auth.sessionFor(remote)).toBeNull()
  })
})
