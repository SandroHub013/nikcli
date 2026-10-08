import os from "os"
import { Installation } from "@/installation"
import { Provider } from "@/provider/provider"
import { Log } from "@nikcli-ai/util/log"
import { NoNativeRouteError } from "@/provider/error"
import { Config } from "@/config/config"
import { streamLegacy } from "@/provider/legacy/stream"
import { withStreamFallback } from "./llm/fallback"
import { convertToModelMessages } from "@/session/llm/ui-messages"
import {
  isModelMessage as isModelMessageShape,
  type ModelMessage,
  type StreamOutput as TurnOutput,
  type Tool,
  type ToolSet,
  type UIMessage,
  tool,
  jsonSchema,
} from "@/session/llm/types"
import type { ProviderOptions } from "@nikcli-ai/llm"
import type { JsonValue } from "@/util/json"
import z from "zod"
import {
  type ModelRef,
  LLMRequest as LLMRequestClass,
  SystemPart,
  GenerationOptions,
  HttpOptions,
} from "@nikcli-ai/llm"
import { clone, mergeDeep, pipe } from "remeda"
import { ProviderTransform } from "@/provider/transform"
import { CacheDiagnostics } from "@/provider/cache-diagnostics"
import * as CachePolicy from "@/provider/cache-policy"
import { CacheKeeper } from "./cache-keeper"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { OpenAIWebSocketPool } from "@/plugin/openai/ws-pool"
import { Mod } from "../mod"
import { SystemPrompt } from "./system"
import { Flag } from "@nikcli-ai/util/flag"
import { PermissionNext } from "@/permission/next"
import { Auth } from "@/auth"
import { Effect } from "effect"
import { InstanceState, runPromiseWithLayer, withCurrentInstance } from "@/effect"
import { LLMNativeRuntime } from "./llm/native-runtime"
import { executeTools, extractThinkTags, streamResult, toProcessorStream } from "./llm/llm-event-adapter"
import {
  NativeRequestUnsupported,
  toLLMMessages,
  toLLMProviderOptions,
  toLLMToolChoice,
  toLLMToolDefinitions,
} from "./llm/native-request"
import * as LLMCoverage from "./llm/coverage"

export namespace LLM {
  const log = Log.create({ service: "llm" })

  // Only allocated when the flag is on, so the default path keeps no snapshots.
  const cacheDiagnostics = Flag.NIKCLI_PROMPT_CACHE_DIAGNOSTICS ? new CacheDiagnostics.Tracker() : undefined
  export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

  function runAuth<A, E>(effect: Effect.Effect<A, E, Auth.Service>) {
    return runPromiseWithLayer(Auth.defaultLayer, effect)
  }

  function runPlugin<A, E>(effect: Effect.Effect<A, E, Plugin.Service>) {
    return runPromiseWithLayer(Plugin.defaultLayer, withCurrentInstance(effect))
  }

  function runProvider<A, E>(effect: Effect.Effect<A, E, Provider.Service>) {
    return runPromiseWithLayer(Provider.defaultLayer, withCurrentInstance(effect))
  }

  // Build request headers based on provider and model configuration
  export function buildRequestHeaders(
    projectID: string,
    providerID: string,
    sessionID: string,
    userID: string,
    isCodex: boolean,
    _modelHeaders?: Record<string, string>,
    title = false,
  ): Record<string, string> | undefined {
    if (isCodex) {
      return {
        originator: "nikcli",
        "User-Agent": `nikcli/${Installation.VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`,
        session_id: sessionID,
        // Read and removed by the WebSocket pool (OpenAIWebSocketPool): a title is one short request that
        // should not open a socket of its own, so it goes over HTTP.
        ...(title ? { [OpenAIWebSocketPool.TITLE_HEADER]: "true" } : {}),
      }
    }

    if (providerID.startsWith("nikcli")) {
      return {
        "x-nikcli-project": projectID,
        "x-nikcli-session": sessionID,
        "x-nikcli-request": userID,
        "x-nikcli-client": Flag.NIKCLI_CLIENT,
      }
    }

    if (providerID !== "anthropic") {
      return {
        "User-Agent": `nikcli/${Installation.VERSION}`,
      }
    }

    // Return undefined for anthropic (no extra headers needed)
    return undefined
  }

  export type StreamInput = {
    user: MessageV2.User
    sessionID: string
    model: Provider.Model
    agent: Agent.Info
    system: string[]
    abort: AbortSignal
    messages: ModelMessage[]
    small?: boolean
    tools: Record<string, Tool>
    /**
     * Entries of `tools` the model can call but is not sent the schema of:
     * deferred tools a session has not loaded yet (`SessionTools.resolveTools`).
     */
    deferred?: ReadonlySet<string>
    retries?: number
    /** Retries the caller has made so far for this call (the processor's `attempt`), for the line that says why the fallback ran. */
    attempt?: number
    /**
     * Whether the caller will retry this error by itself (`SessionRetry.retryFollows`). Asked when the native stream fails before
     * any output: if it will, the error goes up to those retries, and the AI SDK fallback is what is left after them.
     */
    retryFollows?: (error: unknown) => boolean | Promise<boolean>
    toolChoice?: "auto" | "required" | "none"
    /**
     * The request carries the conversation's tools (so its prefix is the conversation's) but the model must not use them: a
     * compaction that shares the prefix. `toolChoice` is then the provider's way of saying so (`uncallableToolChoice`), and any tool
     * call in the answer is dropped, never run.
     */
    noToolCalls?: boolean
  }

  /**
   * The `tool_choice` of a request whose tools stay in the prefix but must not be called. Anthropic's cache key covers `tool_choice`,
   * so a changed one invalidates the cached messages: there it stays the conversation's (`same`) and `noToolCalls` drops what the model
   * calls anyway. Elsewhere `none` costs nothing. `NIKCLI_COMPACTION_TOOL_CHOICE` forces either.
   */
  export function uncallableToolChoice(route: string, same: StreamInput["toolChoice"]): StreamInput["toolChoice"] {
    const mode = Flag.compactionToolChoice() ?? (route === "anthropic-messages" ? "same" : "none")
    return mode === "none" ? "none" : same
  }

  async function* withoutToolCalls<T extends { type: string }>(events: AsyncIterable<T>): AsyncGenerator<T> {
    for await (const event of events) {
      if (event.type.startsWith("tool-")) continue
      yield event
    }
  }

  export type StreamOutput = TurnOutput

  type StreamMessageInput = ModelMessage | UIMessage | JsonValue

  interface ProviderCallOptions {
    [key: string]: JsonValue | undefined
  }

  const UIMessageEnvelope = z.object({
    role: z.enum(["user", "assistant"]),
    parts: z.array(z.unknown()),
  })

  const PartsOnlyMessage = z.object({
    parts: z.array(z.unknown()),
    content: z.undefined(),
  })

  const RepairablePart = z
    .object({
      type: z.string().catch(""),
      text: z.string().catch(""),
    })
    .catch({ type: "", text: "" })

  const RepairableMessage = z.object({
    role: z.enum(["user", "assistant", "system"]).catch("user"),
    parts: z.array(RepairablePart).optional().catch(undefined),
    content: z.string().optional().catch(undefined),
  })

  function isModelMessage(message: StreamMessageInput): message is ModelMessage {
    return isModelMessageShape(message)
  }

  function isUIMessage(message: StreamMessageInput): message is UIMessage {
    return UIMessageEnvelope.safeParse(message).success
  }

  // Some messages reach `normalizeStreamMessages` shaped like UIMessages but
  // with roles outside `user`/`assistant` (e.g. a `system` carrying a `parts`
  // array, or an empty role). These slip past both `isModelMessage` and
  // `isUIMessage`, so the legacy cast pushed them straight to streamText and
  // triggered `AI_InvalidPromptError`. `looksLikeUIMessage` widens detection
  // so the normalizer can repair them.
  function looksLikeUIMessage(message: StreamMessageInput): boolean {
    return PartsOnlyMessage.safeParse(message).success
  }

  // Best-effort repair: collapse a malformed UI-shaped message into a single
  // string-content ModelMessage by concatenating any `text`/`reasoning` parts.
  // Returns undefined when there's nothing salvageable so the caller can drop
  // the message instead of forwarding garbage to the model.
  function repairMessage(message: StreamMessageInput): ModelMessage | undefined {
    const parsed = RepairableMessage.safeParse(message)
    if (!parsed.success) return undefined
    const { role, parts, content } = parsed.data
    if (parts) {
      const text = parts
        .filter((p) => p.type === "text" || p.type === "reasoning")
        .map((p) => p.text)
        .join("")
        .trim()
      if (text.length === 0) return undefined
      return { role, content: text } as ModelMessage
    }
    if (content !== undefined && content.length > 0) {
      return { role, content } as ModelMessage
    }
    return undefined
  }

  function uiToolOutput(output: JsonValue) {
    const asText = z.string().safeParse(output)
    if (asText.success) return { type: "text" as const, value: asText.data }
    return { type: "json" as const, value: output as never }
  }

  function uiMessageTools(messages: UIMessage[]) {
    const tools: Record<string, { toModelOutput: typeof uiToolOutput }> = {}
    for (const message of messages) {
      for (const part of message.parts) {
        if (!part.type.startsWith("tool-")) continue
        tools[part.type.slice("tool-".length)] = {
          toModelOutput: uiToolOutput,
        }
      }
    }
    return tools
  }

  export function normalizeStreamMessages(messages: StreamMessageInput[]): ModelMessage[] {
    const result: ModelMessage[] = []
    let uiRun: UIMessage[] = []

    const flushUIRun = () => {
      if (uiRun.length === 0) return
      result.push(
        ...convertToModelMessages(uiRun, {
          tools: uiMessageTools(uiRun) as unknown as ToolSet,
        }),
      )
      uiRun = []
    }

    for (const message of messages) {
      if (isModelMessage(message)) {
        flushUIRun()
        result.push(message)
        continue
      }
      if (isUIMessage(message)) {
        uiRun.push(message)
        continue
      }
      // Widened: anything UI-shaped (has `parts`) that isn't strictly a
      // UIMessage gets routed through the same convertToModelMessages path
      // by repairing the role to user.
      if (looksLikeUIMessage(message)) {
        const candidate = message as {
          role?: unknown
          parts: UIMessage["parts"]
        }
        const role: UIMessage["role"] = candidate.role === "assistant" ? "assistant" : "user"
        uiRun.push({ ...(message as object), role } as UIMessage)
        continue
      }
      // Last resort: try to recover a plain string-content ModelMessage from
      // arbitrary garbage. If that fails, drop the message with a warning so
      // it never reaches streamText (where it would throw the opaque
      // AI_InvalidPromptError).
      const repaired = repairMessage(message)
      if (repaired) {
        flushUIRun()
        result.push(repaired)
        continue
      }
      log.warn("dropping malformed message before streamText", {
        snapshot: JSON.stringify(message).slice(0, 200),
      })
    }

    flushUIRun()
    return result
  }

  export async function stream(input: StreamInput) {
    // One read at the entry, for the `x-nikcli-project` header built in two
    // places below. Reading it inside the header builder put it on whichever
    // fiber the request happened to be assembled on.
    const projectID = InstanceState.ambient().project.id
    const l = log
      .clone()
      .tag("providerID", input.model.providerID)
      .tag("modelID", input.model.id)
      .tag("sessionID", input.sessionID)
      .tag("small", (input.small ?? false).toString())
      .tag("agent", input.agent.name)
    l.info("stream", {
      modelID: input.model.id,
      providerID: input.model.providerID,
    })
    const [{ provider, modelRef }, auth, cfg] = await Promise.all([
      runProvider(
        Effect.gen(function* () {
          const service = yield* Provider.Service
          const provider = yield* service.getProvider(input.model.providerID)
          const modelRef = yield* service.getModelRef(input.model)
          return { provider, modelRef }
        }),
      ),
      runAuth(
        Effect.gen(function* () {
          const auth = yield* Auth.Service
          return yield* auth.get(input.model.providerID)
        }),
      ),
      runPromiseWithLayer(
        Config.defaultLayer,
        withCurrentInstance(
          Effect.gen(function* () {
            return yield* (yield* Config.Service).get()
          }),
        ),
      ),
    ])
    if (!provider) {
      throw new Provider.ModelNotFoundError({
        providerID: input.model.providerID,
        modelID: input.model.id,
      })
    }
    if (modelRef) {
      l.debug("model ref resolved", {
        route: modelRef.route,
        baseURL: modelRef.baseURL,
        modelID: modelRef.id,
        providerID: modelRef.provider,
      })
    } else {
      // `mapToModelRef` returned undefined: no native route can carry this model. See `session/llm/coverage.ts`.
      LLMCoverage.record({
        outcome: "unmapped",
        providerID: input.model.providerID,
        modelID: input.model.id,
      })
    }
    const isCodex = provider.id === "openai" && auth?.type === "oauth"

    const system = SystemPrompt.header(input.model.providerID)
    // The body of the system prompt as named sections, so `prompt.section` and `prompt.compose`
    // mods can see and change each. With no such mod this joins to exactly what it always did.
    const providerPrompt = () =>
      SystemPrompt.provider(input.model)
        .filter((x) => x)
        .join("\n")
    const sections: Mod.PromptSection[] = [
      // use agent prompt otherwise provider prompt
      // For Codex sessions, skip SystemPrompt.provider() since it's sent via options.instructions
      // The build agent's own prompt only adds monitor, delegation and research
      // guidance; on its own it left the model without the provider prompt's
      // coding workflow, so build gets both, the provider prompt first.
      ...(input.agent.prompt
        ? input.agent.name === "build" && !isCodex
          ? [{ id: "provider", text: providerPrompt() }, { id: "agent", text: input.agent.prompt }]
          : [{ id: "agent", text: input.agent.prompt }]
        : [{ id: "provider", text: isCodex ? "" : providerPrompt() }]),
      // any custom prompt passed into this call
      { id: "system", text: input.system.filter((x) => x).join("\n") },
      // any custom prompt from last user message
      { id: "user", text: input.user.system ?? "" },
    ].filter((section) => section.text)
    system.push(
      (await Mod.promptSections(sections))
        .map((section) => section.text)
        .filter((x) => x)
        .join("\n"),
    )

    const header = system[0]
    const original = clone(system)
    await runPlugin(
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        yield* plugin.trigger("experimental.chat.system.transform", { sessionID: input.sessionID }, { system })
      }),
    )
    if (system.length === 0) {
      system.push(...original)
    }
    // rejoin to maintain 2-part structure for caching if header unchanged
    if (system.length > 2 && system[0] === header) {
      const rest = system.slice(1)
      system.length = 0
      system.push(header, rest.join("\n"))
    }

    const variant =
      !input.small && input.model.variants && input.user.variant ? input.model.variants[input.user.variant] : {}
    const base = input.small
      ? ProviderTransform.smallOptions(input.model)
      : ProviderTransform.options({
          model: input.model,
          sessionID: input.sessionID,
          providerOptions: provider.options,
        })
    const merged = pipe(base, mergeDeep(input.model.options), mergeDeep(input.agent.options), mergeDeep(variant))
    // SAFETY: the bag is assembled from zod-validated config/catalog/agent options and
    // JSON-shaped plugin payloads; the LLM boundary consumes it as JSON call options.
    const options = (isCodex ? { ...merged, instructions: SystemPrompt.instructions() } : merged) as ProviderCallOptions

    const params = await runPlugin(
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        return yield* plugin.trigger(
          "chat.params",
          {
            sessionID: input.sessionID,
            agent: input.agent,
            model: input.model,
            provider,
            message: input.user,
          },
          {
            temperature: input.model.capabilities.temperature
              ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
              : undefined,
            topP: input.agent.topP ?? ProviderTransform.topP(input.model),
            topK: ProviderTransform.topK(input.model),
            options,
          },
        )
      }),
    )

    const maxOutputTokens =
      isCodex || provider.id.includes("github-copilot") ? undefined : ProviderTransform.maxOutputTokens(input.model)

    const resolvedTools = await resolveTools(input)
    // xAI multi-agent models reject client-side function tools ("Client-side tools
    // for multi-agent models require beta access") — they only run xAI's built-in
    // server-side tools. Drop client-side tools for them so the session doesn't 400.
    const tools = ProviderTransform.tools(input.model, resolvedTools)
    if (Object.keys(resolvedTools).length > 0 && Object.keys(tools).length === 0) {
      l.warn("dropping client-side tools (model does not support them)", {
        modelID: input.model.api.id,
        providerID: input.model.providerID,
        dropped: Object.keys(resolvedTools).length,
      })
    }
    const providerOptions = ProviderTransform.providerOptions(input.model, params.options)
    const openrouterOptions = providerOptions.openrouter
    const fusionPlugin = Array.isArray(openrouterOptions?.plugins)
      ? openrouterOptions.plugins.find((plugin: any) => plugin?.id === "fusion")
      : undefined
    if (fusionPlugin && process.env.NIKCLI_DEBUG_OPENROUTER_FUSION === "1") {
      l.info("openrouter fusion request options", {
        modelID: input.model.api.id,
        variant: input.user.variant,
        openrouterOptions,
      })
    }

    // LiteLLM and some Anthropic proxies require the tools parameter to be present
    // when message history contains tool calls, even if no tools are being used.
    // Add a dummy tool that is never called to satisfy this validation.
    // This is enabled for:
    // 1. Providers with "litellm" in their ID or API ID (auto-detected)
    // 2. Providers with explicit "litellmProxy: true" option (opt-in for custom gateways)
    const isLiteLLMProxy =
      provider.options?.["litellmProxy"] === true ||
      input.model.providerID.toLowerCase().includes("litellm") ||
      input.model.api.id.toLowerCase().includes("litellm")

    if (isLiteLLMProxy && Object.keys(tools).length === 0 && hasToolCalls(input.messages)) {
      tools["_noop"] = tool({
        description:
          "Placeholder for LiteLLM/Anthropic proxy compatibility - required when message history contains tool calls but no active tools are needed",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => ({ output: "", title: "", metadata: {} }),
      })
    }

    const messages = normalizeStreamMessages([
      ...(isCodex
        ? [
            {
              role: "user",
              content: system.join("\n\n"),
            } as ModelMessage,
          ]
        : system.map(
            (x): ModelMessage => ({
              role: "system",
              content: x,
            }),
          )),
      ...input.messages,
    ])

    const requestHeaders = buildRequestHeaders(
      projectID,
      input.model.providerID,
      input.sessionID,
      input.user.id,
      isCodex,
      input.model.headers,
      input.agent.name === "title",
    )

    const legacy = async () => {
      input.abort.throwIfAborted()
      // The compaction that shares the prefix keeps the conversation's tools in the request and drops what the model calls: the AI SDK
      // would run them. It has no fallback; the compaction falls back to the way of today (no tools) by itself.
      if (input.noToolCalls) throw new Error("the shared-prefix compaction has no AI SDK path")
      l.debug("llm.runtime", { runtime: "ai-sdk" })
      const language = await runProvider(
        Effect.gen(function* () {
          return yield* (yield* Provider.Service).getLanguage(input.model)
        }),
      )
      return streamLegacy({
        language,
        model: input.model,
        messages,
        tools,
        deferred: input.deferred,
        providerOptions,
        ...params,
        options: params.options ?? options,
        maxOutputTokens,
        toolChoice: input.toolChoice,
        abort: input.abort,
        retries: input.retries,
        headers: requestHeaders,
      })
    }
    if (!modelRef || cfg.experimental?.nativeLlm === false) {
      if (modelRef) {
        LLMCoverage.record({
          outcome: "fallback",
          providerID: modelRef.provider,
          modelID: modelRef.id,
          reason: cfg.experimental?.nativeLlm === false ? "nativeLlm disabled" : "no modelRef",
        })
      }
      return legacy()
    }
    const nativeStatus = LLMNativeRuntime.status({
      model: input.model,
      provider,
      auth,
      modelRef,
    })
    if (nativeStatus.type !== "supported") {
      LLMCoverage.record({
        outcome: "ineligible",
        providerID: modelRef.provider,
        modelID: modelRef.id,
        reason: nativeStatus.reason,
      })
      LLMCoverage.record({
        outcome: "fallback",
        providerID: modelRef.provider,
        modelID: modelRef.id,
        reason: `ineligible: ${nativeStatus.reason}`,
      })
      return legacy()
    }

    l.debug("llm.runtime", { runtime: "native", route: modelRef.route })
    let result: StreamOutput
    try {
      result = await streamNative({
        streamInput: input,
        modelRef,
        provider,
        auth,
        params,
        options,
        providerOptions,
        maxOutputTokens,
        system,
        messages,
        tools,
        headers: requestHeaders,
        isCodex,
        l,
      })
    } catch (error) {
      if (input.abort.aborted || (error instanceof Error && error.name === "AbortError")) throw error
      // The caller's retries come first, then the fallback.
      if (await input.retryFollows?.(error)) throw error
      l.warn("native request failed before streaming, using ai-sdk", {
        error: String(error),
        attempts: input.attempt ?? 0,
      })
      LLMCoverage.record({
        outcome: "fallback",
        providerID: modelRef.provider,
        modelID: modelRef.id,
        reason: "setup failure",
      })
      return legacy()
    }
    LLMCoverage.record({
      outcome: "native",
      providerID: modelRef.provider,
      modelID: modelRef.id,
    })
    return streamResult(
      withStreamFallback(
        result.fullStream,
        legacy,
        input.abort,
        (reason) => {
          l.warn("native stream failed before any output, using ai-sdk", { reason, attempts: input.attempt ?? 0 })
          LLMCoverage.record({
            outcome: "fallback",
            providerID: modelRef.provider,
            modelID: modelRef.id,
            reason,
          })
        },
        async (error) => !(await input.retryFollows?.(error)),
      ),
    ) as StreamOutput
  }

  async function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "user">) {
    const tools = { ...input.tools }
    const disabled = PermissionNext.disabled(Object.keys(tools), input.agent.permission)
    for (const tool of Object.keys(tools)) {
      if (input.user.tools?.[tool] === false || disabled.has(tool)) {
        delete tools[tool]
      }
    }
    return tools
  }

  // Check if messages contain any tool-call content
  // Used to determine if a dummy tool should be added for LiteLLM proxy compatibility
  export function hasToolCalls(messages: ModelMessage[]): boolean {
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue
      for (const part of msg.content) {
        if (part.type === "tool-call" || part.type === "tool-result") return true
      }
    }
    return false
  }

  // ── @nikcli-ai/llm request ─────────────────────────────────────────────
  // Message/tool conversion lives in `./llm/native-request`.

  /**
   * Build an @nikcli-ai/llm LLMRequest.
   *
   * `system` and `messages` are passed in rather than read off the stream input:
   * the input carries only the caller's custom system strings and the raw message
   * history, while what the model must see is the assembled system prompt (header,
   * agent/provider prompt, plugin transforms) and the history after
   * `ProviderTransform.message`.
   */
  export function buildLLMRequest(
    input: {
      system: readonly string[]
      messages: readonly ModelMessage[]
      tools: Record<string, Tool>
      deferred?: ReadonlySet<string>
      toolChoice?: StreamInput["toolChoice"]
    },
    modelRef: ModelRef,
    genParams: {
      temperature?: number
      topP?: number
      topK?: number
      maxOutputTokens?: number
      providerOptions?: ProviderOptions
      options?: ProviderCallOptions
    },
    headers?: Record<string, string>,
  ): LLMRequestClass {
    // One part per system string: the cache policy marks the first and last, which a joined string would collapse.
    const system = input.system.filter((x) => x).flatMap((x) => SystemPart.content(x))

    const maxTokens = genParams.maxOutputTokens ?? (genParams.options?.["maxOutputTokens"] as number | undefined)
    const generation = new GenerationOptions({
      maxTokens,
      temperature: genParams.temperature,
      topP: genParams.topP,
      topK: genParams.topK,
    })
    const hasGen = Object.values(generation).some((v) => v !== undefined)

    return new LLMRequestClass({
      model: modelRef,
      system,
      messages: toLLMMessages(input.messages),
      tools: toLLMToolDefinitions(input.tools, input.deferred),
      generation: hasGen ? generation : undefined,
      providerOptions: genParams.providerOptions,
      http: headers && Object.keys(headers).length > 0 ? new HttpOptions({ headers }) : undefined,
      toolChoice: toLLMToolChoice(input.toolChoice),
      cache: CachePolicy.nativePolicy(modelRef.route),
    })
  }

  async function streamNative(input: {
    streamInput: StreamInput
    modelRef: ModelRef
    provider: Provider.Info
    auth: Auth.Info | undefined
    params: {
      temperature?: number
      topP?: number
      topK?: number
      options?: ProviderCallOptions
    }
    options: ProviderCallOptions
    providerOptions: ProviderCallOptions
    maxOutputTokens: number | undefined
    system: string[]
    messages: ModelMessage[]
    tools: Record<string, Tool>
    headers: Record<string, string> | undefined
    isCodex: boolean
    l: ReturnType<typeof log.clone>
  }) {
    // The session's prompt, normalised for this provider but without cache markers: the native route places
    // its own breakpoints from the request's cache policy. `message` rewrites messages in place and the
    // originals are still the tool context's `messages`, so it gets copies down to the part level.
    const messages = ProviderTransform.message(
      input.messages.map((m) =>
        Array.isArray(m.content)
          ? ({
              ...m,
              content: m.content.map((part) => ({ ...part })),
            } as ModelMessage)
          : { ...m },
      ),
      input.streamInput.model,
      input.options,
      { cache: false },
    )

    let llmRequest: LLMRequestClass
    try {
      llmRequest = buildLLMRequest(
        {
          // Codex carries the system prompt as the first user message and `instructions`.
          system: input.isCodex ? [] : input.system,
          messages,
          tools: input.tools,
          deferred: input.streamInput.deferred,
          toolChoice: input.streamInput.noToolCalls
            ? uncallableToolChoice(input.modelRef.route, input.streamInput.toolChoice)
            : input.streamInput.toolChoice,
        },
        input.modelRef,
        {
          temperature: input.params.temperature,
          topP: input.params.topP,
          topK: input.params.topK,
          maxOutputTokens: input.maxOutputTokens,
          providerOptions: toLLMProviderOptions(input.modelRef.route, input.providerOptions) as ProviderOptions,
          options: input.params.options,
        },
        input.headers,
      )
    } catch (e) {
      // Content the canonical schema cannot carry. Refused before anything is sent; discovered mid-stream
      // it would be an opaque provider error.
      if (!(e instanceof NativeRequestUnsupported)) throw e
      throw refuse(input, e.reason)
    }

    // The wire-level request (cache markers included), so the diff reflects what the provider matches against.
    if (cacheDiagnostics) {
      const { comparison, snapshot } = cacheDiagnostics.record(input.streamInput.sessionID, {
        prompt: [
          ...llmRequest.system.map((part) => ({
            role: "system",
            content: part,
          })),
          ...llmRequest.messages,
        ],
        tools: llmRequest.tools,
        settings: {
          model: input.streamInput.model.id,
          providerID: input.streamInput.model.providerID,
          temperature: input.params.temperature,
          topP: input.params.topP,
          topK: input.params.topK,
          maxOutputTokens: input.maxOutputTokens,
          toolChoice: input.streamInput.toolChoice,
          providerOptions: llmRequest.providerOptions,
        },
      })
      log.info("prompt cache prefix", {
        sessionID: input.streamInput.sessionID,
        toolCount: snapshot.tools.length,
        systemParts: snapshot.system.length,
        messageCount: snapshot.messages.length,
        ...comparison,
      })
    }

    // The keeper learns what this request's prefix is, so it can keep the entry alive once the session is idle. It never gets in the
    // turn's way: a failure here is nothing the turn has to know. Not for titles, nor for subagents or the compaction (their entries
    // are not the session's).
    if (input.isCodex) CacheKeeper.markCodex(input.streamInput.sessionID)
    if (CacheKeeper.active(undefined, input.isCodex) && !input.streamInput.small && input.streamInput.agent.mode !== "subagent" && input.streamInput.agent.name !== "compaction" && !input.streamInput.noToolCalls) {
      try {
        CacheKeeper.observe({
          sessionID: input.streamInput.sessionID,
          request: llmRequest,
          fetch: Provider.nativeFetch(input.provider),
          ctx: CacheKeeper.instanceOf(),
          codex: input.isCodex,
        })
      } catch (error) {
        log.debug("cache keeper did not observe the request", { error: String(error) })
      }
    }

    const native = LLMNativeRuntime.streamRequestOnly({
      model: input.streamInput.model,
      provider: input.provider,
      auth: input.auth,
      modelRef: input.modelRef,
      llmRequest,
      messages,
      abort: input.streamInput.abort,
    })

    if (native.type === "unsupported") throw refuse(input, native.reason)

    const events = toProcessorStream(extractThinkTags(native.events))
    const fullStream = executeTools(input.streamInput.noToolCalls ? withoutToolCalls(events) : events, {
      tools: input.tools,
      messages: input.messages,
      abort: input.streamInput.abort,
    })
    return streamResult(fullStream) as unknown as StreamOutput
  }

  function refuse(input: { modelRef: ModelRef; l: ReturnType<typeof log.clone> }, reason: string) {
    input.l.debug("native llm refused the request", { reason })
    // Distinct from the pre-flight `ineligible`: that one is a configuration verdict, this one is the
    // route refusing once it has been compiled. Same outcome for the user, different thing to fix.
    LLMCoverage.record({
      outcome: "ineligible-late",
      providerID: input.modelRef.provider,
      modelID: input.modelRef.id,
      reason,
    })
    return new NoNativeRouteError({
      providerID: input.modelRef.provider,
      modelID: input.modelRef.id,
      reason,
    })
  }
}
