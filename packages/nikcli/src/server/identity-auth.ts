import { verifyAccessToken, type VerifyAccessTokenOptions } from "@nikcli-ai/auth"
import { Effect } from "effect"
import { Flag } from "@nikcli-ai/util/flag"
import { Account } from "@/account"
import { runPromiseWithLayer } from "@/effect"
import { UserDB } from "@/user/users"

const DEFAULT_ISSUER = "https://auth.nikcli.store"

/**
 * The server is the single trust boundary in
 * `specs/effect-tui/12-identity-onboarding-auth.md`: it verifies the issuer JWT
 * and the TUI/SDK/CLI consume its typed answers rather than re-validating the
 * signature themselves. That spec turns login/refresh/expiry/revocation into
 * one state machine on top of this verifier; it does not replace it.
 */
export function identityVerifierOptions(): VerifyAccessTokenOptions | undefined {
  // Default-on: every nikcli server accepts issuer JWTs. Verification is
  // lazy — the JWKS is only fetched when a JWT-shaped bearer arrives, so
  // offline/local servers with no OAuth clients never touch the network.
  // Set NIKCLI_AUTH_ISSUER=off (or 0/false) to disable entirely.
  const raw = Flag.NIKCLI_AUTH_ISSUER?.trim()
  if (raw && ["off", "0", "false", "none"].includes(raw.toLowerCase())) return
  const issuer = raw || DEFAULT_ISSUER
  const jwksUrl = Flag.NIKCLI_AUTH_JWKS_URL ?? new URL("/.well-known/jwks.json", issuer).toString()
  return {
    issuer,
    audience: Flag.NIKCLI_AUTH_AUDIENCE,
    jwksUrl: Flag.NIKCLI_AUTH_JWT_SECRET ? undefined : jwksUrl,
    jwtSecret: Flag.NIKCLI_AUTH_JWT_SECRET,
  }
}

export async function externalSessionForToken(
  token: string,
): Promise<{ user: UserDB.PublicUser; token: string } | undefined> {
  const verifier = identityVerifierOptions()
  if (!verifier) return
  const auth = await verifyAccessToken(token, verifier)
  if (!auth.email) throw new Error("Identity token is missing the verified email claim")
  return {
    user: Effect.runSync(UserDB.ensureExternalUser({ sub: auth.accountID, email: auth.email })),
    token,
  }
}

/**
 * The session this machine holds, independent of what the caller presented.
 *
 * The terminal stores the issuer access token in a file and sends it as its
 * bearer, but that token lives about fifteen minutes while the account row
 * beside it carries a refresh token and renews itself. Every launch after the
 * first quarter hour therefore arrived with a dead bearer and read as signed
 * out — which is how a signed-in user got the sign-in dialog on every start.
 *
 * Identity is resolved from the renewing side instead. `Account.token`
 * refreshes when the stored token is close to expiry, and what it hands back
 * is verified here exactly like any other bearer: the caller's expired token
 * is never trusted, it is ignored. That is also why only callers the router
 * already admits without credentials may reach this — see `Auth.sessionFor`.
 * It answers "who is signed in on this machine", not "who sent this request".
 */
export async function localAccountSession(): Promise<{ user: UserDB.PublicUser; token: string } | undefined> {
  if (!identityVerifierOptions()) return
  const token = await runPromiseWithLayer(
    Account.defaultLayer,
    Effect.gen(function* () {
      const account = yield* Account.Service
      const active = yield* account.active()
      if (!active) return undefined
      return yield* account.token(active.id)
    }),
  )
  if (!token) return
  return externalSessionForToken(token)
}
