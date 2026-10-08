import { describe, expect, it } from "bun:test"
import { createVerify, generateKeyPairSync } from "crypto"
import { createTokenSource } from "@/provider/google-auth"

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const serviceAccount = JSON.stringify({
  type: "service_account",
  client_email: "svc@proj.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
})
const user = JSON.stringify({
  type: "authorized_user",
  client_id: "cid",
  client_secret: "secret",
  refresh_token: "refresh",
})

function harness(files: Record<string, string>, env: Record<string, string> = {}) {
  const calls: Array<{ url: string; body: URLSearchParams | undefined }> = []
  let clock = 1_000_000
  let counter = 0
  const fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body instanceof URLSearchParams ? init.body : undefined })
    if (String(url).includes("metadata.google.internal")) {
      return new Response(JSON.stringify({ access_token: "meta-token", expires_in: 3600 }))
    }
    return new Response(JSON.stringify({ access_token: `token-${++counter}`, expires_in: 3600 }))
  }) as unknown as typeof globalThis.fetch
  const source = createTokenSource({
    fetch,
    env,
    now: () => clock,
    readFile: async (file) => {
      if (file in files) return files[file]!
      throw new Error("ENOENT")
    },
  })
  return { source, calls, advance: (ms: number) => (clock += ms) }
}

describe("Google ADC token source", () => {
  it("exchanges a service-account key with a verifiable RS256 JWT", async () => {
    const { source, calls } = harness(
      { "/creds.json": serviceAccount },
      { GOOGLE_APPLICATION_CREDENTIALS: "/creds.json" },
    )
    expect(await source()).toBe("token-1")

    const body = calls[0]!.body!
    expect(calls[0]!.url).toBe("https://oauth2.googleapis.com/token")
    expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer")
    const [header, claims, signature] = body.get("assertion")!.split(".")
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" })
    const payload = JSON.parse(Buffer.from(claims!, "base64url").toString())
    expect(payload).toMatchObject({
      iss: "svc@proj.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: "https://oauth2.googleapis.com/token",
    })
    expect(payload.exp - payload.iat).toBe(3600)
    const verified = createVerify("RSA-SHA256")
      .update(`${header}.${claims}`)
      .verify(publicKey, Buffer.from(signature!, "base64url"))
    expect(verified).toBe(true)
  })

  it("refreshes a user credential from the gcloud ADC file", async () => {
    const { source, calls } = harness(
      { "/home/.config/gcloud/application_default_credentials.json": user },
      { CLOUDSDK_CONFIG: "/home/.config/gcloud" },
    )
    expect(await source()).toBe("token-1")
    expect(calls[0]!.body!.get("grant_type")).toBe("refresh_token")
    expect(calls[0]!.body!.get("refresh_token")).toBe("refresh")
    expect(calls[0]!.body!.get("client_id")).toBe("cid")
  })

  it("caches the token and renews it a minute before it expires", async () => {
    const { source, calls, advance } = harness({ "/c.json": user }, { GOOGLE_APPLICATION_CREDENTIALS: "/c.json" })
    expect(await source()).toBe("token-1")
    advance(3_000_000)
    expect(await source()).toBe("token-1")
    expect(calls).toHaveLength(1)
    advance(540_001)
    expect(await source()).toBe("token-2")
    expect(calls).toHaveLength(2)
  })

  it("shares one exchange between concurrent callers", async () => {
    const { source, calls } = harness({ "/c.json": user }, { GOOGLE_APPLICATION_CREDENTIALS: "/c.json" })
    const tokens = await Promise.all([source(), source(), source()])
    expect(tokens).toEqual(["token-1", "token-1", "token-1"])
    expect(calls).toHaveLength(1)
  })

  it("falls back to the metadata server when no credential file exists", async () => {
    const { source, calls } = harness({})
    expect(await source()).toBe("meta-token")
    expect(calls[0]!.url).toContain("metadata.google.internal")
  })

  it("names the missing credentials when nothing is found", async () => {
    const source = createTokenSource({
      fetch: (async () => {
        throw new Error("offline")
      }) as unknown as typeof globalThis.fetch,
      env: {},
      readFile: async () => {
        throw new Error("ENOENT")
      },
    })
    await expect(source()).rejects.toThrow(/GOOGLE_APPLICATION_CREDENTIALS/)
  })

  it("surfaces an unreadable explicitly-configured credentials file", async () => {
    const { source } = harness({}, { GOOGLE_APPLICATION_CREDENTIALS: "/missing.json" })
    await expect(source()).rejects.toThrow(/\/missing\.json/)
  })

  it("reports a rejected token exchange with the status", async () => {
    const source = createTokenSource({
      fetch: (async () => new Response("invalid_grant", { status: 400 })) as unknown as typeof globalThis.fetch,
      env: { GOOGLE_APPLICATION_CREDENTIALS: "/c.json" },
      readFile: async () => user,
    })
    await expect(source()).rejects.toThrow(/400/)
  })
})
