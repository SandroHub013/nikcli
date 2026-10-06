import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { auth } from "@modelcontextprotocol/sdk/client/auth.js"
import { McpOAuthProvider } from "@/mcp/oauth-provider"

/*
 * SDK 1.31 stamps what it passes to `saveTokens` and `saveClientInformation` with `issuer`, the
 * authorization server it discovered, and drops stored credentials stamped for another one. That
 * binding only works if the provider gives back what it was given. nikcli's provider kept its own
 * shape and lost the stamp: the refresh token could still go to any authorization server, and every
 * refresh printed `[mcp-sdk] stored OAuth tokens have no 'issuer' ...`.
 *
 * These tests run the real SDK `auth()` against a fake `fetch`: no server, no network.
 */

const SERVER = "https://mcp.example/mcp"
const AS_A = "https://as-a.example"
const AS_B = "https://as-b.example"
const NO_ISSUER = /have no 'issuer'/

function fakeNetwork(authorizationServer: string) {
  const posts: string[] = []
  const requested: string[] = []
  const fetchFn = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    requested.push(url)
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
    if (url.startsWith("https://mcp.example/.well-known/oauth-protected-resource")) {
      return json({ resource: SERVER, authorization_servers: [authorizationServer] })
    }
    if (url.startsWith(authorizationServer) && url.includes("/.well-known/oauth-authorization-server")) {
      return json({
        issuer: authorizationServer,
        authorization_endpoint: `${authorizationServer}/authorize`,
        token_endpoint: `${authorizationServer}/token`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
      })
    }
    if (url === `${authorizationServer}/token` && init?.method === "POST") {
      posts.push(url)
      return json({ access_token: "new-access", token_type: "Bearer", refresh_token: "new-refresh", expires_in: 3600 })
    }
    return new Response("not found", { status: 404 })
  }
  return { fetchFn, posts, requested }
}

let redirects: URL[]
let names: string[]

function provider(name: string) {
  names.push(name)
  return new McpOAuthProvider(name, SERVER, { clientId: "client-1" }, { onRedirect: (url) => void redirects.push(url) })
}

beforeEach(() => {
  redirects = []
  names = []
})

afterEach(async () => {
  // The store is the suite's own temporary home; leave it as found.
  const { McpAuth } = await import("@/mcp/auth")
  const { Effect } = await import("effect")
  for (const name of names) {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* McpAuth.Service
        yield* store.remove(name)
      }).pipe(Effect.provide(McpAuth.defaultLayer)),
    )
  }
})

describe("MCP OAuth provider keeps the issuer the SDK stamps", () => {
  it("hands back the issuer it was given with the tokens", async () => {
    const p = provider("issuer-roundtrip")
    await p.saveTokens({ access_token: "a", token_type: "Bearer", refresh_token: "r", issuer: AS_A })

    expect((await p.tokens())?.issuer).toBe(AS_A)
  })

  it("hands back the issuer of a dynamically registered client", async () => {
    const p = new McpOAuthProvider("issuer-client", SERVER, {}, { onRedirect: () => {} })
    names.push("issuer-client")
    await p.saveClientInformation({
      client_id: "dyn-1",
      redirect_uris: [p.redirectUrl],
      issuer: AS_A,
    })

    expect((await p.clientInformation())?.issuer).toBe(AS_A)
  })

  it("does not send a refresh token to an authorization server it was not issued by", async () => {
    const p = provider("issuer-bound-elsewhere")
    await p.saveTokens({ access_token: "a", token_type: "Bearer", refresh_token: "secret-refresh", issuer: AS_A })
    // nikcli saves the state before it starts an authorization.
    await p.saveState("state-1")
    const network = fakeNetwork(AS_B)

    const result = await auth(p, { serverUrl: SERVER, fetchFn: network.fetchFn })

    // Without the stamp the refresh token went to AS_B's token endpoint.
    expect(network.posts).toEqual([])
    expect(result).toBe("REDIRECT")
    expect(redirects).toHaveLength(1)
  })

  it("refreshes against the authorization server that issued the tokens, without the SDK's warning", async () => {
    const p = provider("issuer-same-server")
    await p.saveTokens({ access_token: "a", token_type: "Bearer", refresh_token: "r", issuer: AS_A })
    const network = fakeNetwork(AS_A)
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const result = await auth(p, { serverUrl: SERVER, fetchFn: network.fetchFn })

      expect(result).toBe("AUTHORIZED")
      expect(network.posts).toEqual([`${AS_A}/token`])
      expect(warn.mock.calls.filter(([message]) => NO_ISSUER.test(String(message)))).toEqual([])
      expect((await p.tokens())?.issuer).toBe(AS_A)
    } finally {
      warn.mockRestore()
    }
  })

  it("keeps tokens saved before the stamp existed working, and stamps them once they refresh", async () => {
    const p = provider("issuer-legacy")
    await p.saveTokens({ access_token: "a", token_type: "Bearer", refresh_token: "legacy-refresh" })
    expect((await p.tokens())?.issuer).toBeUndefined()
    const network = fakeNetwork(AS_A)
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(await auth(p, { serverUrl: SERVER, fetchFn: network.fetchFn })).toBe("AUTHORIZED")
      expect(network.posts).toEqual([`${AS_A}/token`])
      expect((await p.tokens())?.issuer).toBe(AS_A)

      // The second refresh finds the stamp: no warning from here on.
      warn.mockClear()
      expect(await auth(p, { serverUrl: SERVER, fetchFn: network.fetchFn })).toBe("AUTHORIZED")
      expect(warn.mock.calls.filter(([message]) => NO_ISSUER.test(String(message)))).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it("uses the client from the configuration whichever authorization server discovery lands on", async () => {
    // A client the SDK once stamped for AS_A is stored under the same name; the tokens belong to AS_B, which is
    // where discovery points now (a failed read of the resource metadata is enough to land elsewhere).
    const stamped = new McpOAuthProvider("issuer-config-client", SERVER, {}, { onRedirect: () => {} })
    names.push("issuer-config-client")
    await stamped.saveClientInformation({ client_id: "client-1", redirect_uris: [stamped.redirectUrl], issuer: AS_A })
    const p = provider("issuer-config-client")
    await p.saveTokens({ access_token: "a", token_type: "Bearer", refresh_token: "r", issuer: AS_B })
    const network = fakeNetwork(AS_B)
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const result = await auth(p, { serverUrl: SERVER, fetchFn: network.fetchFn })

      // Stamped, the client would be dropped for AS_B and a new one registered: there is no endpoint for it.
      expect(result).toBe("AUTHORIZED")
      expect(network.posts).toEqual([`${AS_B}/token`])
      expect(network.requested.filter((url) => url.includes("register"))).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it("does not save the client from the configuration, so nothing can bind it", async () => {
    const p = provider("issuer-config-client-save")
    await p.saveClientInformation({ client_id: "client-1", redirect_uris: [p.redirectUrl], issuer: AS_A })

    const reader = new McpOAuthProvider("issuer-config-client-save", SERVER, {}, { onRedirect: () => {} })
    expect(await reader.clientInformation()).toBeUndefined()
  })
})
