import { afterEach, describe, expect, it } from "bun:test"
import { guardNikFetch } from "../helpers/no-nik-fetch"

/*
 * Brief ragu-via-servizi-nik, package B, Master's request: every ragu server trusted, by default, the JWTs of Nik's
 * issuer (https://auth.nikcli-ai.dev): a bearer signed there became a user of this server, and the server fetched
 * Nik's JWKS to check it. A server trusts no issuer unless RAGU_AUTH_ISSUER names one.
 */
const { identityVerifierOptions, externalSessionForToken, localAccountSession } = await import("@/server/identity-auth")

const KEYS = ["RAGU_AUTH_ISSUER", "RAGU_AUTH_JWKS_URL", "RAGU_AUTH_JWT_SECRET"] as const
const saved = new Map<string, string | undefined>()
function set(key: (typeof KEYS)[number], value: string | undefined) {
  if (!saved.has(key)) saved.set(key, process.env[key])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  saved.clear()
})

/** A JWT-shaped bearer naming Nik's issuer; the signature is never reached. */
function nikToken() {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return [
    part({ alg: "RS256", typ: "JWT", kid: "nik" }),
    part({ iss: "https://auth.nikcli-ai.dev", sub: "acc_1", email: "someone@example.com", exp: 4_102_444_800 }),
    "signature",
  ].join(".")
}

describe("the server trusts no issuer unless one is configured", () => {
  it("without RAGU_AUTH_ISSUER there is no verifier, not even with a JWKS url or a secret alone", () => {
    for (const KEY of KEYS) set(KEY, undefined)
    expect(identityVerifierOptions()).toBeUndefined()
    set("RAGU_AUTH_JWKS_URL", "https://keys.example/jwks.json")
    expect(identityVerifierOptions()).toBeUndefined()
    set("RAGU_AUTH_JWT_SECRET", "a-secret-long-enough-for-hs256-abcdefgh")
    expect(identityVerifierOptions()).toBeUndefined()
  })

  it("a bearer from Nik's issuer is no session and costs no network call", async () => {
    for (const KEY of KEYS) set(KEY, undefined)
    const guard = guardNikFetch()
    try {
      expect(await externalSessionForToken(nikToken())).toBeUndefined()
      expect(await localAccountSession()).toBeUndefined()
      expect(guard.attempts).toEqual([])
    } finally {
      guard.restore()
    }
  })

  it("an issuer named explicitly is still trusted", () => {
    set("RAGU_AUTH_ISSUER", "https://auth.example")
    set("RAGU_AUTH_JWT_SECRET", undefined)
    set("RAGU_AUTH_JWKS_URL", undefined)
    expect(identityVerifierOptions()).toMatchObject({
      issuer: "https://auth.example",
      jwksUrl: "https://auth.example/.well-known/jwks.json",
    })
  })
})
