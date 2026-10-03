import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { withFixture } from "../helpers/fixture"

type ProviderConfig = Record<string, unknown>

/** Resolve `getModelRef` for a model of a config-defined provider, in an isolated instance. */
async function resolve(providers: Record<string, ProviderConfig>, providerID: string, modelID = "m") {
  return withFixture(async ({ home }) => {
    const previous = process.env.NIKCLI_DISABLE_PROJECT_CONFIG
    const previousModelsFetch = process.env.NIKCLI_DISABLE_MODELS_FETCH
    process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "0"
    process.env.NIKCLI_DISABLE_MODELS_FETCH = "1"
    const { Instance } = await import("@/project/instance")
    const { Provider } = await import("@/provider/provider")
    const { runPromiseWithLayer, withCurrentInstance } = await import("@/effect")
    try {
      await Bun.write(
        path.join(home, "nikcli.json"),
        JSON.stringify({ enabled_providers: Object.keys(providers), provider: providers }),
      )
      return await Instance.provide({
        directory: home,
        fn: () =>
          runPromiseWithLayer(
            Provider.defaultLayer,
            withCurrentInstance(
              Effect.gen(function* () {
                const service = yield* Provider.Service
                const model = yield* service.getModel(providerID, modelID)
                return yield* service.getModelRef(model)
              }),
            ),
          ),
      })
    } finally {
      await Instance.disposeAll()
      if (previous === undefined) delete process.env.NIKCLI_DISABLE_PROJECT_CONFIG
      else process.env.NIKCLI_DISABLE_PROJECT_CONFIG = previous
      if (previousModelsFetch === undefined) delete process.env.NIKCLI_DISABLE_MODELS_FETCH
      else process.env.NIKCLI_DISABLE_MODELS_FETCH = previousModelsFetch
    }
  })
}

const models = { m: { name: "M", limit: { context: 8192, output: 1024 } } }

describe("Provider.getModelRef", () => {
  it("maps an OpenAI-compatible provider and carries its configured headers", async () => {
    const ref = await resolve(
      {
        gateway: {
          npm: "@ai-sdk/openai-compatible",
          api: "https://gw.example/v1",
          options: { apiKey: "k", headers: { "x-team": "core", "x-skip": 7 } },
          models: { m: { ...models.m, headers: { "x-model": "m1" } } },
        },
      },
      "gateway",
    )
    expect(ref?.baseURL).toBe("https://gw.example/v1")
    expect(ref?.headers).toEqual({ "x-team": "core", "x-model": "m1" })
  })

  it("does not guess OpenAI-compatible for an SDK it cannot map", async () => {
    const ref = await resolve(
      {
        custom: {
          npm: "gitlab-ai-provider",
          api: "https://merge.example/v1",
          options: { apiKey: "k" },
          models,
        },
      },
      "custom",
    )
    expect(ref).toBeUndefined()
  })

  it("maps SDKs that wrap an OpenAI-compatible endpoint onto the family host", async () => {
    for (const [npm, host] of [
      ["@ai-sdk/mistral", "https://api.mistral.ai/v1"],
      ["@ai-sdk/perplexity", "https://api.perplexity.ai"],
      ["@ai-sdk/cohere", "https://api.cohere.ai/compatibility/v1"],
    ] as const) {
      const id = npm.split("/")[1]!
      const ref = await resolve({ [id]: { npm, options: { apiKey: "k" }, models } }, id)
      expect(ref?.baseURL).toBe(host)
      expect(ref?.route).toBe("openai-compatible-chat")
    }
  })

  it("maps azure only when the resource host is known", async () => {
    const known = await resolve(
      {
        azure: { npm: "@ai-sdk/azure", options: { apiKey: "k", resourceName: "contoso" }, models },
      },
      "azure",
    )
    expect(known?.baseURL).toBe("https://contoso.openai.azure.com/openai/v1")

    const unknown = await resolve({ azure: { npm: "@ai-sdk/azure", options: { apiKey: "k" }, models } }, "azure")
    expect(unknown).toBeUndefined()
  })

  it("gives a provider whose auth lives in its fetch a placeholder key", async () => {
    const { Provider } = await import("@/provider/provider")
    const model = {
      id: "m",
      providerID: "gateway",
      api: { id: "m", url: "https://gw.example/v1", npm: "@ai-sdk/openai-compatible" },
    }
    const fetch = async () => new Response()
    const withFetch = Provider.mapToModelRef(model as any, { id: "gateway", options: { fetch } } as any)
    expect(withFetch?.apiKey).toBe(Provider.FETCH_MANAGED_KEY)
    // A real key is never replaced by the placeholder.
    const withKey = Provider.mapToModelRef(model as any, { id: "gateway", options: { fetch, apiKey: "real" } } as any)
    expect(withKey?.apiKey).toBe("real")
    // No key and no fetch: nothing carries a credential, so there is none to invent.
    const bare = Provider.mapToModelRef(model as any, { id: "gateway", options: {} } as any)
    expect(bare?.apiKey).toBeUndefined()
  })
})

describe("Provider.mapToModelRef: gateways and clouds", () => {
  const map = async (npm: string, info: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const { Provider } = await import("@/provider/provider")
    const providerID = (info.id as string) ?? "p"
    const model = { id: "m", providerID, api: { id: "m", npm, url: "", ...extra }, headers: {} }
    return Provider.mapToModelRef(model as any, { options: {}, ...info } as any)
  }

  it("maps the Vercel gateway to its own route on the gateway host", async () => {
    const ref = await map("@ai-sdk/gateway", { id: "vercel", options: { apiKey: "k" } })
    expect(ref?.route).toBe("vercel-gateway")
    expect(ref?.baseURL).toBe("https://ai-gateway.vercel.sh/v1")
  })

  it("maps aihubmix, venice and merge onto their OpenAI-compatible hosts", async () => {
    const cases = [
      ["@aihubmix/ai-sdk-provider", "aihubmix", "https://aihubmix.com/v1"],
      ["venice-ai-sdk-provider", "venice", "https://api.venice.ai/api/v1"],
      ["merge-gateway-ai-sdk-provider", "merge-gateway", "https://api-gateway.merge.dev/v1/openai"],
    ] as const
    for (const [npm, id, host] of cases) {
      const ref = await map(npm, { id, options: { apiKey: "k" } })
      expect(ref?.baseURL).toBe(host)
      expect(ref?.route).toBe("openai-compatible-chat")
    }
  })

  it("does not send Merge's SDK-specific catalog URL to the OpenAI-compatible route", async () => {
    const ref = await map(
      "merge-gateway-ai-sdk-provider",
      { id: "merge-gateway", options: { apiKey: "k" } },
      { url: "https://api-gateway.merge.dev/v1/ai-sdk" },
    )
    expect(ref?.baseURL).toBe("https://api-gateway.merge.dev/v1/openai")
  })

  it("maps Cloudflare AI Gateway through the URL its loader built", async () => {
    const ref = await map(
      "ai-gateway-provider",
      { id: "cloudflare-ai-gateway", options: { apiKey: "k" } },
      { url: "https://gateway.ai.cloudflare.com/v1/acct/gw/compat" },
    )
    expect(ref?.baseURL).toBe("https://gateway.ai.cloudflare.com/v1/acct/gw/compat")
    expect(ref?.route).toBe("openai-compatible-chat")
  })

  it("maps Vertex Gemini and Claude when the project and location are known", async () => {
    const gemini = await map("@ai-sdk/google-vertex", {
      id: "google-vertex",
      options: { project: "proj", location: "us-east5", fetch: async () => new Response() },
    })
    expect(gemini?.route).toBe("vertex-gemini")
    expect(gemini?.baseURL).toBe(
      "https://us-east5-aiplatform.googleapis.com/v1/projects/proj/locations/us-east5/publishers/google",
    )
    const claude = await map("@ai-sdk/google-vertex/anthropic", {
      id: "google-vertex-anthropic",
      options: { project: "proj", location: "global", fetch: async () => new Response() },
    })
    expect(claude?.route).toBe("vertex-anthropic")
    expect(claude?.baseURL).toBe(
      "https://aiplatform.googleapis.com/v1/projects/proj/locations/global/publishers/anthropic",
    )
  })

  it("leaves Vertex unmapped without a project", async () => {
    expect(await map("@ai-sdk/google-vertex", { id: "google-vertex", options: {} })).toBeUndefined()
  })

  it("maps an Azure Cognitive Services resource through its own host", async () => {
    const ref = await map(
      "@ai-sdk/azure",
      { id: "azure-cognitive-services", options: { apiKey: "k" } },
      { url: "https://res.cognitiveservices.azure.com/openai" },
    )
    expect(ref?.baseURL).toBe("https://res.cognitiveservices.azure.com/openai/v1")
  })

  it("leaves SDKs with no native protocol unmapped", async () => {
    for (const npm of ["gitlab-ai-provider", "@jerome-benoit/sap-ai-provider-v2", "watsonx-ai-provider"]) {
      expect(await map(npm, { id: "x", options: { apiKey: "k" } }, { url: "https://x.example/v1" })).toBeUndefined()
    }
  })
})

describe("Provider.mapToModelRef: custom providers by protocol", () => {
  const map = async (
    options: Record<string, unknown>,
    npm = "some-ai-sdk-provider",
    url = "https://llm.example/v1",
  ) => {
    const { Provider } = await import("@/provider/provider")
    const model = { id: "m", providerID: "acme", api: { id: "m", npm, url }, headers: {} }
    return Provider.mapToModelRef(model as any, { id: "acme", options } as any)
  }

  it("routes an unknown SDK by the protocol the provider names", async () => {
    const cases = [
      ["openai-compatible", "openai-compatible-chat"],
      ["openai-responses", "openai-responses"],
      ["anthropic", "anthropic-messages"],
      ["gemini", "gemini"],
    ] as const
    for (const [protocol, route] of cases) {
      const ref = await map({ protocol, apiKey: "k" })
      expect(ref?.route).toBe(route)
      expect(ref?.baseURL).toBe("https://llm.example/v1")
    }
  })

  it("lets the protocol win over a known SDK name", async () => {
    const ref = await map({ protocol: "anthropic", apiKey: "k" }, "@ai-sdk/openai-compatible")
    expect(ref?.route).toBe("anthropic-messages")
  })

  it("needs a baseURL, and refuses a protocol it does not know", async () => {
    expect(await map({ protocol: "anthropic", apiKey: "k" }, "x", "")).toBeUndefined()
    expect(await map({ protocol: "smoke-signals", apiKey: "k" })).toBeUndefined()
  })

  it("serves a plugin-supplied fetch: no key needed, the placeholder stands in for it", async () => {
    const { Provider } = await import("@/provider/provider")
    const ref = await map({ protocol: "openai-compatible", fetch: async () => new Response() })
    expect(ref?.apiKey).toBe(Provider.FETCH_MANAGED_KEY)
  })
})

describe("Provider.nativeFetch", () => {
  const info = (options: Record<string, unknown>) => ({ id: "p", options }) as any

  it("is undefined when the provider carries no fetch and no timeouts", async () => {
    const { Provider } = await import("@/provider/provider")
    expect(Provider.nativeFetch(info({ apiKey: "k" }))).toBeUndefined()
  })

  it("calls the provider's fetch with the body restored to text, so plugins can inspect and replay it", async () => {
    const { Provider } = await import("@/provider/provider")
    const seen: Array<{ url: string; body: unknown }> = []
    const fetch = async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), body: init?.body })
      return new Response("ok")
    }
    const wrapped = Provider.nativeFetch(info({ fetch }))!
    await wrapped("https://api.example/v1/responses", {
      method: "POST",
      body: new TextEncoder().encode('{"model":"m"}'),
    })
    expect(seen).toEqual([{ url: "https://api.example/v1/responses", body: '{"model":"m"}' }])
  })

  it("aborts a request that outlives the configured timeout", async () => {
    const { Provider } = await import("@/provider/provider")
    const fetch = (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))
    const wrapped = Provider.nativeFetch(info({ fetch, timeout: 20 }))!
    await expect(wrapped("https://api.example/v1/responses", { method: "POST" })).rejects.toBeDefined()
  })

  it("keeps the caller's abort signal", async () => {
    const { Provider } = await import("@/provider/provider")
    const controller = new AbortController()
    let signal: AbortSignal | null | undefined
    const fetch = async (_url: unknown, init?: RequestInit) => {
      signal = init?.signal
      return new Response("ok")
    }
    await Provider.nativeFetch(info({ fetch }))!("https://api.example", { signal: controller.signal })
    controller.abort()
    expect(signal?.aborted).toBe(true)
  })
})
