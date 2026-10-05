import { Plugin } from "./index"
import { tool } from "./tool"

export const ExamplePlugin: Plugin = async (ctx) => {
  return {
    tool: {
      mytool: tool({
        description: "This is a custom tool",
        args: {
          foo: tool.schema.string().describe("foo"),
        },
        async execute(args) {
          return `Hello ${args.foo}!`
        },
      }),
    },
  }
}

/**
 * A provider nikcli has no built-in support for.
 *
 * nikcli talks to models through native routes (OpenAI Chat, OpenAI Responses, Anthropic Messages, Gemini),
 * so a service that speaks one of those wire protocols needs no SDK: name the protocol and the host, and
 * supply whatever the service needs on top of a static key. The loader's `fetch` is what every request
 * goes through, so request signing, token renewal or a rewritten endpoint live there.
 *
 * The same can be written in config, without a plugin, for a service that only needs an API key:
 * `provider.acme.options = { protocol: "openai-compatible", baseURL, apiKey }`.
 */
export const ExampleProviderPlugin: Plugin = async () => {
  return {
    provider: {
      id: "acme",
      async models() {
        return {
          "acme-large": {
            id: "acme-large",
            providerID: "acme",
            name: "Acme Large",
            api: { id: "acme-large", url: "https://llm.acme.example/v1", npm: "acme" },
          } as any,
        }
      },
    },
    auth: {
      provider: "acme",
      methods: [{ type: "api", label: "Acme API key" }],
      async loader(getAuth) {
        const auth = await getAuth()
        const key = auth.type === "api" ? auth.key : undefined
        return {
          // One of: "openai-compatible" | "openai-responses" | "anthropic" | "gemini".
          protocol: "openai-compatible",
          baseURL: "https://llm.acme.example/v1",
          // A placeholder is enough when `fetch` sets the credential itself.
          apiKey: key ?? "unused",
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            const headers = new Headers(init?.headers)
            headers.set("x-acme-token", `Bearer ${key ?? ""}`)
            headers.delete("authorization")
            return fetch(input, { ...init, headers })
          },
        }
      },
    },
  }
}
