import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Effect, Layer, Schema } from "effect"
import { Config } from "@/config/config"
import { Log } from "@nikcli-ai/util/log"
import type * as ChatBotModule from "@/chatbot"
import { InstanceState, runPromiseWithLayer, withCurrentInstance } from "@/effect"

/**
 * The chat-bot manager, as a declared group.
 *
 * The webhook receivers next door stay raw — platform SDKs verify signatures
 * against the untouched `Request` — but these three are ordinary JSON and the
 * only caller is a TUI feature plugin, which reaches the server through
 * `api.client.<group>`, the generated client. A raw handler would be
 * unreachable from there.
 *
 * Sharing the `/chatbot` prefix with raw routes is why `ChatbotHttp.handle`
 * now falls through instead of answering 404 for what it does not match.
 */
export namespace ChatbotHttpApi {
  const Bot = Schema.Struct({
    name: Schema.String,
    type: Schema.String,
    running: Schema.Boolean,
    webhookPath: Schema.String,
  }).annotate({ identifier: "ChatbotBot" })

  const StartResult = Schema.Struct({
    running: Schema.Boolean,
    error: Schema.optional(Schema.String),
  }).annotate({ identifier: "ChatbotStartResult" })

  const StopResult = Schema.Struct({
    removed: Schema.Boolean,
  }).annotate({ identifier: "ChatbotStopResult" })

  const NamePath = Schema.Struct({ name: Schema.String }).annotate({
    identifier: "ChatbotNamePath",
  })

  const fromPromise = <A>(fn: () => Promise<A>) => Effect.promise(fn).pipe(Effect.orDie)

  const log = Log.create({ service: "server.chatbot" })

  /**
   * Loaded on demand, never at module scope.
   *
   * `public.ts` imports this file to declare the group, so a top-level
   * `import { ChatBot }` would drag the Chat SDK into every process that merely
   * *serves* HTTP — and it registers state on import. That is not theoretical:
   * doing it broke `ToolRegistry`'s canonical id ordering in the same run.
   */
  const chatbot = () => import("@/chatbot").then((module) => module.ChatBot)

  type ChatBotModule = Awaited<ReturnType<typeof chatbot>>

  /**
   * The same load, for a read that must not fail because of it.
   *
   * `@/chatbot` pulls in every chat platform SDK, `@slack/web-api` among them,
   * and that SDK's axios stack touches the network while it initialises. On a
   * machine that cannot reach the registry or Slack, the import itself throws —
   * and `GET /chatbot/bots`, which only reports which connectors are configured
   * and which are up, answered 500. A listing that cannot reach a platform SDK
   * still knows every other connector, so it degrades to an empty list and says
   * why, rather than refusing the read.
   */
  async function chatbotOrEmpty(): Promise<ChatBotModule | undefined> {
    try {
      return await chatbot()
    } catch (error) {
      log.warn("chat platform SDKs unavailable; reporting no bots", {
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }

  export const Group = HttpApiGroup.make("chatbot")
    .add(HttpApiEndpoint.get("bots", "/bots", { success: Schema.Array(Bot) }))
    .add(
      HttpApiEndpoint.post("start", "/bots/:name/start", {
        params: NamePath,
        success: StartResult,
      }),
    )
    .add(
      HttpApiEndpoint.post("stop", "/bots/:name/stop", {
        params: NamePath,
        success: StopResult,
      }),
    )
    .prefix("/chatbot")

  export const Api = HttpApi.make("nikcli").add(Group)
  export const ApiLive = HttpApiBuilder.layer(Api)

  function configGet() {
    return runPromiseWithLayer(
      Config.defaultLayer,
      withCurrentInstance(
        Effect.gen(function* () {
          const config = yield* Config.Service
          return yield* config.get()
        }),
      ),
    )
  }

  /** The configured connector for `name`, if it names a chat platform at all. */
  async function connector(name: string) {
    const ChatBot = await chatbot()
    const config = await configGet()
    const raw = (config.connectors ?? {})[name]
    if (typeof raw !== "object" || raw === null) return undefined
    const entry = raw as Config.Connector
    if (typeof entry.type !== "string" || !ChatBot.isChatPlatform(entry.type)) return undefined
    return entry
  }

  export const handlers = {
    /**
     * Every configured chat connector, with the state the manager shows.
     *
     * The join of "configured" and "running" happens here. The terminal used to
     * do it by reading its synced config and calling `getAllBots()` in process,
     * but only this process knows which bots are up — that half was never
     * derivable from config.
     */
    bots: () =>
      fromPromise(async () => {
        const ChatBot = await chatbotOrEmpty()
        const config = await configGet()
        // Without the SDKs there is no platform to name, so the honest answer is
        // an empty list — not a 500 on a read the caller cannot act on anyway.
        if (!ChatBot) return []
        const running = ChatBot.getAllBots()
        const entries = []
        for (const [name, raw] of Object.entries(config.connectors ?? {})) {
          if (typeof raw !== "object" || raw === null) continue
          const entry = raw as Config.Connector
          if (typeof entry.type !== "string" || !ChatBot.isChatPlatform(entry.type)) continue
          entries.push({
            name,
            type: entry.type,
            running: running.has(name),
            webhookPath: ChatBot.getWebhookPath(entry.type, name),
          })
        }
        return entries
      }),

    start: ({ params }: { params: { name: string } }) =>
      Effect.flatMap(InstanceState.context, (instance) =>
        fromPromise(async () => {
          const entry = await connector(params.name)
          if (!entry)
            return {
              running: false,
              error: `No chat connector named ${params.name}`,
            }
          try {
            // Lazily imported: the handlers pull the agent and provider chain,
            // which no request that never starts a bot should pay for.
            const { BotHandlers } = await import("@/chatbot/handlers")
            const bot = await BotHandlers.ensureAiBot(instance, params.name, entry)
            if (!bot) {
              return {
                running: false,
                error: `Could not start ${params.name} — check credentials (nikcli bot auth)`,
              }
            }
            return { running: true }
          } catch (cause) {
            return {
              running: false,
              error: cause instanceof Error ? cause.message : String(cause),
            }
          }
        }),
      ),

    // `removed: false` is not an error — the manager says "was not running".
    stop: ({ params }: { params: { name: string } }) =>
      fromPromise(async () => ({
        removed: (await chatbot()).removeBot(params.name),
      })),
  }

  export const HandlersLive = HttpApiBuilder.group(Api, "chatbot", (builder) =>
    builder.handle("bots", handlers.bots).handle("start", handlers.start).handle("stop", handlers.stop),
  )

  export const layer = ApiLive.pipe(Layer.provide(HandlersLive))
}
