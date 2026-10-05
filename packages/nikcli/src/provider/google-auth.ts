/**
 * Google Application Default Credentials, enough to call Vertex AI.
 *
 * Vertex takes an OAuth access token as a bearer. This finds credentials the way Google's own libraries
 * do and exchanges them for one, without pulling in a Google auth package:
 *
 *  1. the file `GOOGLE_APPLICATION_CREDENTIALS` points at;
 *  2. the gcloud ADC file (`gcloud auth application-default login`);
 *  3. the GCE/Cloud Run metadata server.
 *
 * A service-account key is exchanged with a signed JWT (RS256); a user credential with its refresh token.
 * Tokens are cached until a minute before they expire, and concurrent callers share one exchange.
 */
import { createSign } from "crypto"
import { readFile } from "fs/promises"
import os from "os"
import path from "path"

const SCOPE = "https://www.googleapis.com/auth/cloud-platform"
const TOKEN_URI = "https://oauth2.googleapis.com/token"
const METADATA_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"
/** Renew this long before expiry, so a request never leaves with a token that dies in flight. */
const SKEW_MS = 60_000

type ServiceAccount = { type: "service_account"; client_email: string; private_key: string; token_uri?: string }
type AuthorizedUser = {
  type: "authorized_user"
  client_id: string
  client_secret: string
  refresh_token: string
  token_uri?: string
}
type Credentials = ServiceAccount | AuthorizedUser

type Token = { value: string; expiresAt: number }

export type Deps = {
  fetch?: typeof globalThis.fetch
  env?: Record<string, string | undefined>
  readFile?: (file: string) => Promise<string>
  now?: () => number
}

const base64url = (input: string | Uint8Array) =>
  (typeof input === "string" ? Buffer.from(input) : Buffer.from(input)).toString("base64url")

function wellKnownFile(env: Record<string, string | undefined>) {
  if (process.platform === "win32" && env.APPDATA) {
    return path.join(env.APPDATA, "gcloud", "application_default_credentials.json")
  }
  return path.join(
    env.CLOUDSDK_CONFIG ?? path.join(os.homedir(), ".config", "gcloud"),
    "application_default_credentials.json",
  )
}

async function loadCredentials(deps: Required<Pick<Deps, "env" | "readFile">>): Promise<Credentials | undefined> {
  const candidates = [deps.env.GOOGLE_APPLICATION_CREDENTIALS, wellKnownFile(deps.env)].filter(
    (file): file is string => !!file,
  )
  for (const [index, file] of candidates.entries()) {
    let parsed: unknown
    try {
      parsed = JSON.parse(await deps.readFile(file))
    } catch (error) {
      // An explicitly named file that cannot be read is a configuration error worth surfacing; the
      // well-known one simply may not exist.
      if (index === 0 && deps.env.GOOGLE_APPLICATION_CREDENTIALS) {
        throw new Error(`GOOGLE_APPLICATION_CREDENTIALS (${file}) could not be read: ${(error as Error).message}`)
      }
      continue
    }
    const credentials = parsed as Partial<Credentials>
    if (credentials?.type === "service_account" || credentials?.type === "authorized_user") {
      return credentials as Credentials
    }
  }
  return undefined
}

async function tokenResponse(
  response: Response,
  source: string,
): Promise<{ access_token: string; expires_in: number }> {
  if (!response.ok) {
    throw new Error(
      `Google token request (${source}) failed with ${response.status}: ${(await response.text()).slice(0, 300)}`,
    )
  }
  const json = (await response.json()) as { access_token?: string; expires_in?: number }
  if (!json.access_token) throw new Error(`Google token response (${source}) carried no access_token`)
  return { access_token: json.access_token, expires_in: json.expires_in ?? 3600 }
}

async function exchange(credentials: Credentials, deps: Required<Pick<Deps, "fetch" | "now">>): Promise<Token> {
  const uri = credentials.token_uri ?? TOKEN_URI
  if (credentials.type === "service_account") {
    const iat = Math.floor(deps.now() / 1000)
    const claims = { iss: credentials.client_email, scope: SCOPE, aud: uri, iat, exp: iat + 3600 }
    const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify(claims))}`
    const signature = createSign("RSA-SHA256").update(unsigned).sign(credentials.private_key)
    const response = await deps.fetch(uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${base64url(signature)}`,
      }),
    })
    const token = await tokenResponse(response, "service account")
    return { value: token.access_token, expiresAt: deps.now() + token.expires_in * 1000 }
  }
  const response = await deps.fetch(uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: credentials.client_id,
      client_secret: credentials.client_secret,
      refresh_token: credentials.refresh_token,
    }),
  })
  const token = await tokenResponse(response, "user credentials")
  return { value: token.access_token, expiresAt: deps.now() + token.expires_in * 1000 }
}

async function fromMetadata(deps: Required<Pick<Deps, "fetch" | "now">>): Promise<Token | undefined> {
  try {
    const response = await deps.fetch(METADATA_URL, {
      headers: { "Metadata-Flavor": "Google" },
      // Off Google Cloud the name does not resolve; do not make every first request wait for it.
      signal: AbortSignal.timeout(1_000),
    })
    if (!response.ok) return undefined
    const token = await tokenResponse(response, "metadata server")
    return { value: token.access_token, expiresAt: deps.now() + token.expires_in * 1000 }
  } catch {
    return undefined
  }
}

/** A token source: call it for a bearer; it caches and refreshes. */
export function createTokenSource(deps: Deps = {}) {
  const resolved = {
    fetch: deps.fetch ?? globalThis.fetch,
    env: deps.env ?? (process.env as Record<string, string | undefined>),
    readFile: deps.readFile ?? ((file: string) => readFile(file, "utf8")),
    now: deps.now ?? Date.now,
  }
  let cached: Token | undefined
  let pending: Promise<Token> | undefined

  const mint = async (): Promise<Token> => {
    const credentials = await loadCredentials(resolved)
    const token = credentials ? await exchange(credentials, resolved) : await fromMetadata(resolved)
    if (!token) {
      throw new Error(
        "No Google credentials found for Vertex AI. Set GOOGLE_APPLICATION_CREDENTIALS to a service-account key, " +
          "or run `gcloud auth application-default login`.",
      )
    }
    return token
  }

  return async function token(): Promise<string> {
    if (cached && cached.expiresAt - SKEW_MS > resolved.now()) return cached.value
    pending ??= mint()
      .then((next) => (cached = next))
      .finally(() => {
        pending = undefined
      })
    return (await pending).value
  }
}

/** The process-wide source. */
export const accessToken = createTokenSource()
