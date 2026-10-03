/**
 * The AI SDK, behind one door.
 *
 * Native `@nikcli-ai/llm` streaming is the default path for a turn. What still needs the AI SDK is the
 * fallback for models the native routes cannot carry (Vertex, gateway, GitLab, custom npm providers,
 * and requests with content a route cannot lower), plus the helper calls that have no native client
 * yet (`generateText`, `generateObject`, `streamObject`, image generation) and the message/tool
 * shapes the session is built on.
 *
 * Every import of `ai`, `@ai-sdk/*` and the other provider SDKs in `src/` lives in this directory, and
 * nowhere else (`test/provider/legacy-isolation.test.ts` enforces it). Code elsewhere imports what it
 * needs from here, so removing the AI SDK is a matter of replacing this file's exports, not hunting
 * through the session, tool and provider code.
 *
 * Provider SDK packages are loaded lazily (`BUNDLED_PROVIDERS`): evaluating all twenty eagerly costs
 * ~2s at process start, while a session only ever touches the ones it actually uses.
 */

export {
  APICallError,
  asSchema,
  convertToModelMessages,
  dynamicTool,
  experimental_generateImage as generateImage,
  extractReasoningMiddleware,
  generateObject,
  generateText,
  JSONParseError,
  jsonSchema,
  LoadAPIKeyError,
  modelMessageSchema,
  NoSuchModelError,
  streamObject,
  streamText,
  tool,
  wrapLanguageModel,
} from "ai"
export type {
  ModelMessage,
  Provider as SDK,
  ProviderMetadata,
  StreamTextResult,
  Tool,
  ToolCallOptions,
  ToolResultPart,
  ToolSet,
  UIMessage,
} from "ai"
export type { JSONSchema7, LanguageModelV2Usage } from "@ai-sdk/provider"
export type { AmazonBedrockProviderSettings } from "@ai-sdk/amazon-bedrock"
export type { LanguageModelV2 } from "@openrouter/ai-sdk-provider"
export type { createGitLab } from "@gitlab/gitlab-ai-provider"

import { streamText, type Provider as SDK, type StreamTextResult, type ToolSet } from "ai"

type BundledFactory = (options: Record<string, unknown>) => SDK

/** Provider SDK factories by npm package, each loaded on first use. */
export const BUNDLED_PROVIDERS: Record<string, () => Promise<BundledFactory>> = {
  "@ai-sdk/amazon-bedrock": () => import("@ai-sdk/amazon-bedrock").then((m) => m.createAmazonBedrock as BundledFactory),
  "@ai-sdk/anthropic": () => import("@ai-sdk/anthropic").then((m) => m.createAnthropic as BundledFactory),
  "@ai-sdk/azure": () => import("@ai-sdk/azure").then((m) => m.createAzure as BundledFactory),
  "@ai-sdk/google": () => import("@ai-sdk/google").then((m) => m.createGoogleGenerativeAI as BundledFactory),
  "@ai-sdk/google-vertex": () => import("@ai-sdk/google-vertex").then((m) => m.createVertex as BundledFactory),
  "@ai-sdk/google-vertex/anthropic": () =>
    import("@ai-sdk/google-vertex/anthropic").then((m) => m.createVertexAnthropic as BundledFactory),
  "@ai-sdk/openai": () => import("@ai-sdk/openai").then((m) => m.createOpenAI as BundledFactory),
  "@ai-sdk/openai-compatible": () =>
    import("@ai-sdk/openai-compatible").then((m) => m.createOpenAICompatible as unknown as BundledFactory),
  "@openrouter/ai-sdk-provider": () =>
    import("@openrouter/ai-sdk-provider").then((m) => m.createOpenRouter as BundledFactory),
  "@ai-sdk/xai": () => import("@ai-sdk/xai").then((m) => m.createXai as BundledFactory),
  "@ai-sdk/mistral": () => import("@ai-sdk/mistral").then((m) => m.createMistral as BundledFactory),
  "@ai-sdk/groq": () => import("@ai-sdk/groq").then((m) => m.createGroq as BundledFactory),
  "@ai-sdk/deepinfra": () => import("@ai-sdk/deepinfra").then((m) => m.createDeepInfra as BundledFactory),
  "@ai-sdk/cerebras": () => import("@ai-sdk/cerebras").then((m) => m.createCerebras as BundledFactory),
  "@ai-sdk/cohere": () => import("@ai-sdk/cohere").then((m) => m.createCohere as BundledFactory),
  "@ai-sdk/gateway": () => import("@ai-sdk/gateway").then((m) => m.createGateway as BundledFactory),
  "@ai-sdk/togetherai": () => import("@ai-sdk/togetherai").then((m) => m.createTogetherAI as BundledFactory),
  "@ai-sdk/perplexity": () => import("@ai-sdk/perplexity").then((m) => m.createPerplexity as BundledFactory),
  "@ai-sdk/vercel": () => import("@ai-sdk/vercel").then((m) => m.createVercel as BundledFactory),
  "@gitlab/gitlab-ai-provider": () =>
    import("@gitlab/gitlab-ai-provider").then((m) => m.createGitLab as unknown as BundledFactory),
  "@ai-sdk/github-copilot": () =>
    import("./copilot").then((m) => m.createOpenaiCompatible as unknown as BundledFactory),
}

export type StreamResult = StreamTextResult<ToolSet, unknown>
export type StreamTextRequest = Parameters<typeof streamText>[0]

/** The AI SDK stream a turn falls back to when the native route cannot take it. */
export function stream(input: StreamTextRequest): StreamResult {
  return streamText(input)
}

/** Keeps a turn that produced only tool calls from rejecting `text` (no content generated) unhandled. */
export function suppressNoContentText<T extends Pick<StreamResult, "text">>(result: T): T {
  result.text.catch(() => {})
  return result
}
