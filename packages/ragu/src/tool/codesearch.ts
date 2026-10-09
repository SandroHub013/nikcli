import { Effect, Schema } from "effect"
import { zod } from "@ragu/util/effect-zod"
import { Tool } from "./tool"
import DESCRIPTION from "./codesearch.txt"
import { callTool } from "./mcp-exa"
import { Config } from "@/config/config"
import { runPromiseWithLayer, withCurrentInstance } from "@/effect"

function websearchConfig() {
  return runPromiseWithLayer(
    Config.defaultLayer,
    withCurrentInstance(
      Effect.gen(function* () {
        const config = yield* Config.Service
        const cfg = yield* config.get()
        return cfg.websearch ?? {}
      }),
    ),
  )
}

interface McpCodeRequest extends Record<string, unknown> {
  query: string
  tokensNum: number
}

const Parameters = Schema.Struct({
  query: Schema.String.annotate({
    description:
      "Search query to find relevant context for APIs, Libraries, and SDKs. For example, 'React useState hook examples', 'Python pandas dataframe filtering', 'Express.js middleware', 'Next js partial prerendering configuration'",
  }),
  tokensNum: Schema.Number.pipe(
    Schema.check(Schema.isGreaterThanOrEqualTo(1000)),
    Schema.check(Schema.isLessThanOrEqualTo(50000)),
    Schema.optional,
    Schema.withDecodingDefault(Effect.succeed(5000)),
  ).annotate({
    description:
      "Number of tokens to return (1000-50000). Default is 5000 tokens. Adjust this value based on how much context you need - use lower values for focused queries and higher values for comprehensive documentation.",
  }),
})

export const CodeSearchTool = Tool.define("codesearch", {
  description: DESCRIPTION,
  parameters: zod(Parameters),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "codesearch",
      patterns: [params.query],
      always: ["*"],
      metadata: {
        query: params.query,
        tokensNum: params.tokensNum,
      },
    })

    const request: McpCodeRequest = {
      query: params.query,
      tokensNum: params.tokensNum || 5000,
    }

    const cfg = await websearchConfig().catch(() => undefined)
    const exaConfigKey = cfg && (!cfg.provider || cfg.provider === "exa") ? cfg.apiKey : undefined
    const apiKey = exaConfigKey ?? process.env["EXA_API_KEY"]

    const text = await callTool({
      tool: "get_code_context_exa",
      args: request,
      signal: ctx.abort,
      timeoutMs: 30000,
      apiKey,
    })
    if (!text) {
      return {
        output:
          "No code snippets or documentation found. Please try a different query, be more specific about the library or programming concept, or check the spelling of framework names.",
        title: `Code search: ${params.query}`,
        metadata: {},
      }
    }
    return {
      output: text,
      title: `Code search: ${params.query}`,
      metadata: {},
    }
  },
})
