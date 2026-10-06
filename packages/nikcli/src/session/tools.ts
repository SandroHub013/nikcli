import { Identifier } from "@nikcli-ai/util/id"
import { MessageV2 } from "./message-v2"
import { Log } from "@nikcli-ai/util/log"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { type JSONSchema7, type Tool as AITool, tool, jsonSchema, type ToolCallOptions } from "@/session/llm/types"
import { ProviderTransform } from "@/provider/transform"
import { Plugin } from "@/plugin"
import { ToolRegistry } from "@/tool/registry"
import { setCallToolExecutor } from "@/tool/call_tool"
import { MCP } from "@/mcp"
import { PermissionNext } from "@/permission/next"
import { Flag } from "@nikcli-ai/util/flag"
import { Truncate } from "@/tool/truncation"
import { Tool } from "@/tool/tool"
import { Config } from "@/config/config"
import { Mod } from "@/mod"
import { Effect } from "effect"
import { InstanceState, runPromiseWithLayer, withCurrentInstance } from "@/effect"
import { Session } from "."
import z from "zod"

const log = Log.create({ service: "session.tools" })

/** Default outer bounds when config leaves timeouts unset. */
const DEFAULT_TOOL_TIMEOUT_MS = 600_000
const DEFAULT_TASK_TIMEOUT_MS = 1_800_000

function runConfig<A, E>(effect: Effect.Effect<A, E, Config.Service>) {
  return runPromiseWithLayer(Config.defaultLayer, withCurrentInstance(effect))
}

export function resolveToolTimeoutCategory(toolID: string, source: "registry" | "mcp"): "task" | "tool" {
  return source === "registry" && toolID === "task" ? "task" : "tool"
}

async function resolveToolTimeoutMs(toolID: string, source: "registry" | "mcp"): Promise<number | undefined> {
  const cfg = await runConfig(
    Effect.gen(function* () {
      const config = yield* Config.Service
      return yield* config.get()
    }),
  )
  const experimental = cfg.experimental
  if (resolveToolTimeoutCategory(toolID, source) === "task") {
    const value = experimental?.task_timeout
    if (value === false) return undefined
    return value ?? DEFAULT_TASK_TIMEOUT_MS
  }
  const value = experimental?.tool_timeout
  if (value === false) return undefined
  return value ?? DEFAULT_TOOL_TIMEOUT_MS
}

/**
 * Run a tool under an outer deadline. On timeout the linked AbortSignal fires so
 * cooperative tools (bash, network) can stop; the promise also rejects if the
 * tool ignores abort (hard outer bound).
 */
export async function executeWithTimeout<T>(
  toolID: string,
  run: (ctx: Tool.Context) => Promise<T>,
  ctx: Tool.Context,
  timeoutMs: number | undefined,
): Promise<T> {
  if (timeoutMs === undefined) return run(ctx)

  const ac = new AbortController()
  const onParentAbort = () => ac.abort()
  if (ctx.abort.aborted) ac.abort()
  else ctx.abort.addEventListener("abort", onParentAbort, { once: true })

  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutError = () => new Error(`Tool "${toolID}" timed out after ${timeoutMs}ms`)

  const linked: Tool.Context = {
    ...ctx,
    abort: ac.signal,
  }

  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        ac.abort()
        reject(timeoutError())
      }, timeoutMs)

      void run(linked).then(
        (result) => {
          if (!timedOut) resolve(result)
        },
        (error) => {
          if (timedOut) {
            reject(timeoutError())
            return
          }
          reject(error)
        },
      )
    })
  } finally {
    if (timer) clearTimeout(timer)
    ctx.abort.removeEventListener("abort", onParentAbort)
  }
}

export function executeMcpWithTimeout<T>(input: {
  toolID: string
  execute: (args: unknown, options: ToolCallOptions) => Promise<T>
  args: unknown
  options: ToolCallOptions
  context: Tool.Context
  timeoutMs: number | undefined
}) {
  return executeWithTimeout<T>(
    input.toolID,
    (linkedCtx) =>
      input.execute(input.args, {
        ...input.options,
        abortSignal: linkedCtx.abort,
      }),
    input.context,
    input.timeoutMs,
  )
}

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

function truncateOutput(text: string, options: Truncate.Options = {}, agent?: Agent.Info) {
  return runPromiseWithLayer(
    Truncate.defaultLayer,
    Effect.gen(function* () {
      const truncate = yield* Truncate.Service
      return yield* truncate.output(text, options, agent)
    }),
  )
}

function toolRegistryTools(model: { providerID: string; modelID: string }, agent?: Agent.Info) {
  return runPromiseWithLayer(
    ToolRegistry.defaultLayer,
    withCurrentInstance(
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        return yield* registry.tools(model, agent)
      }),
    ),
  )
}

function askPermission(input: PermissionNext.AskInput) {
  return runPromiseWithLayer(
    PermissionNext.defaultLayer,
    withCurrentInstance(
      Effect.gen(function* () {
        const permission = yield* PermissionNext.Service
        return yield* permission.ask(input)
      }),
    ),
  )
}

function runPlugin<A, E>(effect: Effect.Effect<A, E, Plugin.Service>) {
  return runPromiseWithLayer(Plugin.defaultLayer, withCurrentInstance(effect))
}

function runMCP<A, E>(effect: Effect.Effect<A, E, MCP.Service>) {
  return runPromiseWithLayer(MCP.defaultLayer, withCurrentInstance(effect))
}

function runSession<A, E>(effect: Effect.Effect<A, E, Session.Service>) {
  return runPromiseWithLayer(Session.defaultLayer, withCurrentInstance(effect))
}

function sessionUpdatePart(part: MessageV2.Part) {
  return runSession(
    Effect.gen(function* () {
      const session = yield* Session.Service
      return yield* session.updatePart(part)
    }),
  )
}

/**
 * The session's toolset for one step.
 *
 * `tools` holds everything the model is offered; `deferred` names the entries of it that are left
 * out of the request. Upstream keeps deferred tools in `tools` so a call by name still runs and
 * loads them. Here a deferred tool is simply not in `tools`: it is reached through `call_tool`,
 * so the array the provider sees is the same bytes on every step of the session and `deferred`
 * is always empty. The field stays because `LLM.stream` and `prompt.ts` take it.
 */
export type ResolvedTools = {
  tools: Record<string, AITool>
  deferred: ReadonlySet<string>
}

export async function resolveTools(input: {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  tools?: Record<string, boolean>
  processor: {
    message: MessageV2.Assistant
    partFromToolCall(toolCallID: string): MessageV2.ToolPart | undefined
  }
  bypassAgentCheck: boolean
}): Promise<ResolvedTools> {
  using _ = log.time("resolveTools")
  const tools: Record<string, AITool> = {}

  // Tools the user disabled for this session are dropped entirely: the model
  // never sees their schema and the permission rule is never registered. The
  // same map also carries the opt-in tools, which are dropped until it says
  // otherwise — see `ToolRegistry.enabled`.
  const disabledTools = input.session.disabledTools ?? {}

  // Wholly-denied tools (`{ tool: { "name*": "deny" } }` with pattern "*") are
  // hidden from the model entirely: advertising them wastes context and the
  // model can't invoke them anyway. Resource-scoped denies (pattern != "*")
  // are kept so the tool still appears in the model schema. See opencode #38060.
  // Single choke point for the effective ruleset, so `--auto`/`--yolo` applies uniformly to every
  // agent instead of having to be threaded through each of their permission definitions.
  const effectiveRuleset = () => {
    const merged = PermissionNext.merge(input.agent.permission, input.session.permission ?? [])
    return Flag.autoApprove() ? PermissionNext.autoApprove(merged) : merged
  }

  const permissionRuleset = effectiveRuleset()

  const context = (args: Record<string, unknown>, options: ToolCallOptions): Tool.Context => ({
    sessionID: input.session.id,
    instance: InstanceState.ambient(),
    abort: options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck },
    agent: input.agent.name,
    metadata: async (val: { title?: string; metadata?: Record<string, unknown> }) => {
      const match = input.processor.partFromToolCall(options.toolCallId)
      if (match && match.state.status === "running") {
        match.state = {
          ...match.state,
          title: val.title,
          metadata: val.metadata,
        }
        await sessionUpdatePart({
          ...match,
          state: match.state,
        })
      }
    },
    progress: async (update) => {
      const match = input.processor.partFromToolCall(options.toolCallId)
      if (match && match.state.status === "running") {
        match.state = {
          ...match.state,
          structured: { ...update.structured },
          content: [...(update.content ?? [])],
        }
        await sessionUpdatePart({
          ...match,
          state: match.state,
        })
      }
    },
    async ask(req: PermissionNext.AskInput) {
      await askPermission({
        ...req,
        sessionID: input.session.id,
        tool: {
          messageID: input.processor.message.id,
          callID: options.toolCallId,
        },
        ruleset: effectiveRuleset(),
        agent: input.agent.name,
      })
    },
  })

  /**
   * The one way a registry tool runs: parameter validation has already happened at
   * the `tool({...})` boundary, and this covers plugin hooks, the per-tool timeout and
   * the result.
   *
   * Extracted so `call_tool` runs a deferred tool through *this* function rather than
   * through a second copy of it. A forwarded call that skipped a hook, a timeout or the
   * permission path would be a different tool wearing the same name.
   */
  const runRegistryTool = async (item: ToolRegistry.Resolved, args: Record<string, unknown>, ctx: Tool.Context) => {
    // Before hook - errors are non-fatal, log and continue
    await runPlugin(
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        yield* plugin.trigger(
          "tool.execute.before",
          {
            tool: item.id,
            sessionID: ctx.sessionID,
            agent: ctx.agent,
            messageID: ctx.messageID,
            callID: ctx.callID,
          },
          {
            args,
          },
        )
      }),
    ).catch((err) => {
      log.debug("plugin trigger failed", {
        error: String(err),
        tool: item.id,
      })
    })
    const timeoutMs = await resolveToolTimeoutMs(item.id, "registry")
    const result = await executeWithTimeout(item.id, (linkedCtx) => item.executeAsync(args, linkedCtx), ctx, timeoutMs)
    // After hook - errors are non-fatal, log and continue
    await runPlugin(
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        yield* plugin.trigger(
          "tool.execute.after",
          {
            tool: item.id,
            sessionID: ctx.sessionID,
            agent: ctx.agent,
            messageID: ctx.messageID,
            callID: ctx.callID,
          },
          result,
        )
      }),
    ).catch((err) => {
      log.debug("plugin trigger failed", {
        error: String(err),
        tool: item.id,
      })
    })
    return result
  }

  const registryTools = await toolRegistryTools(
    { modelID: input.model.api.id, providerID: input.model.providerID },
    input.agent,
  )
  const byId = new Map(registryTools.map((item) => [item.id, item]))
  const eager = await runConfig(
    Effect.gen(function* () {
      const config = yield* Config.Service
      return yield* config.get()
    }),
  ).then((config) => config.tool?.eager ?? [])

  /**
   * `call_tool` runs a tool the model cannot see the schema of. It goes through
   * {@link runRegistryTool}, and the part is reported under the real tool name: the title
   * and the metadata both say `generate_image` rather than `call_tool`, so the session
   * log and the UI read as if the model had called it directly. The part's `tool` field
   * stays `call_tool` because the call the model actually made is what a replay has to
   * show.
   */
  setCallToolExecutor(async (name, forwarded, ctx) => {
    const item = byId.get(name)
    if (!item) {
      const names = [...byId.keys()].sort(ToolRegistry.compareIds)
      return {
        title: `Unknown tool: ${name}`,
        output: [
          `No registered tool is called "${name}".`,
          `Call search_tools with query "${name}" to see what exists, or one of: ${names.join(", ")}.`,
        ].join(" "),
        metadata: { tool: name, ok: false },
      }
    }
    // Visibility is the same check that decides the model's toolset, so a tool the user
    // disabled or a rule denied fails here exactly as it would from the schema.
    if (!ToolRegistry.visible(item.id, { disabledTools, ruleset: permissionRuleset })) {
      return {
        title: `${item.id} is not available`,
        output: `The ${item.id} tool is disabled for this session or denied by permissions, so it cannot run.`,
        metadata: { tool: item.id, ok: false },
      }
    }
    const parsed = item.parameters.safeParse(forwarded)
    if (!parsed.success) {
      const complaint = item.formatValidationError?.(parsed.error) ?? "the arguments do not match its schema"
      return {
        title: `Invalid arguments for ${item.id}`,
        output: [
          `The arguments for ${item.id} do not match its schema: ${complaint}`,
          `Run search_tools with query "${item.id}" to see the parameters it expects.`,
        ].join("\n"),
        metadata: { tool: item.id, ok: false },
      }
    }
    // Run it as its own tool, asking the permission the same way, and report the result
    // under its real name.
    const linked = context(forwarded, {
      toolCallId: ctx.callID,
      abortSignal: ctx.abort,
      messages: [],
    } as never)
    const result = await runRegistryTool(item, parsed.data as Record<string, unknown>, linked)
    await ctx.metadata({
      title: result.title || item.id,
      metadata: { tool: item.id, via: "call_tool", ...result.metadata },
    })
    return { ...result, metadata: { tool: item.id, via: "call_tool", ...result.metadata } }
  })

  // `tool.describe` mods rewrite what the model reads about a tool. Asked once per step, not per tool.
  const describeTools = await Mod.handles("tool.describe")

  for (const item of registryTools) {
    // `deferred` and `hidden` are both kept out of the array: a deferred tool is run through `call_tool`.
    if (ToolRegistry.exposure(item.id, { disabledTools, ruleset: permissionRuleset, eager }) !== "active") continue
    const schema = ProviderTransform.schema(input.model, z.toJSONSchema(item.parameters) as JSONSchema7)
    tools[item.id] = tool({
      id: String(item.id) as `${string}.${string}`,
      description: describeTools ? await Mod.describe(item.id, item.description) : item.description,
      inputSchema: jsonSchema(schema),
      async execute(initialArgs, options) {
        const ctx = context(initialArgs, options)
        // `runRegistryTool` is nikcli's own behaviour for a tool call. `tool.call` mods wrap it:
        // they can change `args`, retry, or answer instead of it.
        return Mod.toolCall(
          {
            tool: item.id,
            sessionID: ctx.sessionID,
            agent: ctx.agent,
            messageID: ctx.messageID,
            callID: ctx.callID,
            args: initialArgs as Record<string, unknown>,
          },
          (callArgs) => runRegistryTool(item, callArgs as typeof initialArgs, ctx),
          (text) => ({ title: item.id, output: text, metadata: {} }) as Awaited<ReturnType<typeof runRegistryTool>>,
          ctx.abort,
        )
      },
      toModelOutput(result) {
        return {
          type: "text",
          value: result.output,
        }
      },
    })
  }

  const mcpTools = await runMCP(
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      return yield* mcp.tools()
    }),
  )
  for (const [key, item] of Object.entries(mcpTools)) {
    if (!ToolRegistry.visible(key, { disabledTools, ruleset: permissionRuleset })) continue
    const execute = item.execute
    if (!execute) continue

    const raw = async (args: Parameters<typeof execute>[0], opts: Parameters<typeof execute>[1]) => {
      const ctx = context(args, opts)

      await runPlugin(
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          yield* plugin.trigger(
            "tool.execute.before",
            {
              tool: key,
              sessionID: ctx.sessionID,
              agent: ctx.agent,
              messageID: ctx.messageID,
              callID: opts.toolCallId,
            },
            {
              args,
            },
          )
        }),
      ).catch((err) => {
        log.debug("plugin trigger failed", { error: String(err), tool: key })
      })

      await ctx.ask({
        permission: key,
        metadata: {},
        patterns: ["*"],
        always: ["*"],
      })

      const timeoutMs = await resolveToolTimeoutMs(key, "mcp")
      const result = await executeMcpWithTimeout<Awaited<ReturnType<typeof execute>>>({
        toolID: key,
        execute,
        args,
        options: opts,
        context: ctx,
        timeoutMs,
      })

      await runPlugin(
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          yield* plugin.trigger(
            "tool.execute.after",
            {
              tool: key,
              sessionID: ctx.sessionID,
              agent: ctx.agent,
              messageID: ctx.messageID,
              callID: opts.toolCallId,
            },
            result,
          )
        }),
      ).catch((err) => {
        log.debug("plugin trigger failed", { error: String(err), tool: key })
      })

      const textParts: string[] = []
      const attachments: MessageV2.FilePart[] = []

      for (const contentItem of result.content) {
        if (contentItem.type === "text") {
          textParts.push(contentItem.text)
        } else if (contentItem.type === "image") {
          attachments.push({
            id: Identifier.ascending("part"),
            sessionID: input.session.id,
            messageID: input.processor.message.id,
            type: "file",
            mime: contentItem.mimeType,
            url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
          })
        } else if (contentItem.type === "resource") {
          const { resource } = contentItem
          if (resource.text) {
            textParts.push(resource.text)
          }
          if (resource.blob) {
            attachments.push({
              id: Identifier.ascending("part"),
              sessionID: input.session.id,
              messageID: input.processor.message.id,
              type: "file",
              mime: resource.mimeType ?? "application/octet-stream",
              url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
              filename: resource.uri,
            })
          }
        }
      }

      const truncated = await truncateOutput(textParts.join("\n\n"), {}, input.agent)
      const metadata = {
        ...result.metadata,
        truncated: truncated.truncated,
        ...(truncated.truncated && { outputPath: truncated.outputPath }),
      }

      return {
        title: "",
        metadata,
        output: truncated.content,
        attachments,
        content: result.content,
      }
    }
    item.execute = async (initialArgs, opts) => {
      const ctx = context(initialArgs, opts)
      return Mod.toolCall(
        {
          tool: key,
          sessionID: ctx.sessionID,
          agent: ctx.agent,
          messageID: ctx.messageID,
          callID: opts.toolCallId,
          args: initialArgs as Record<string, unknown>,
        },
        (callArgs) => raw(callArgs as typeof initialArgs, opts),
        (text) =>
          ({ title: "", metadata: {}, output: text, attachments: [], content: [{ type: "text", text }] }) as Awaited<
            ReturnType<typeof raw>
          >,
        ctx.abort,
      )
    }
    item.toModelOutput = (result) => {
      return {
        type: "text",
        value: result.output,
      }
    }
    tools[key] = item
  }

  const { Connectors } = await import("@/connectors")
  for (const [key, item] of Object.entries(await Connectors.tools())) {
    // Same visibility rule as registry and MCP tools. Connector tools used to
    // honour permission denials but ignore `disabledTools`, so switching one off
    // did nothing the moment the toggle surfaces them.
    if (!ToolRegistry.visible(key, { disabledTools, ruleset: permissionRuleset })) continue
    const execute = item.execute
    if (!execute) continue

    const raw = async (args: Parameters<typeof execute>[0], opts: Parameters<typeof execute>[1]) => {
      const ctx = context(args, opts)

      await runPlugin(
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          yield* plugin.trigger(
            "tool.execute.before",
            {
              tool: key,
              sessionID: ctx.sessionID,
              agent: ctx.agent,
              messageID: ctx.messageID,
              callID: opts.toolCallId,
            },
            {
              args,
            },
          )
        }),
      ).catch((err) => {
        log.debug("plugin trigger failed", { error: String(err), tool: key })
      })

      await ctx.ask({
        permission: key,
        metadata: {},
        patterns: ["*"],
        always: ["*"],
      })

      const result = await execute(args, opts)

      await runPlugin(
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          yield* plugin.trigger(
            "tool.execute.after",
            {
              tool: key,
              sessionID: ctx.sessionID,
              agent: ctx.agent,
              messageID: ctx.messageID,
              callID: opts.toolCallId,
            },
            result,
          )
        }),
      ).catch((err) => {
        log.debug("plugin trigger failed", { error: String(err), tool: key })
      })

      const textOutput = typeof result === "string" ? result : JSON.stringify(result, null, 2)
      const truncated = await truncateOutput(textOutput, {}, input.agent)

      return {
        title: "",
        metadata: { truncated: truncated.truncated },
        output: truncated.content,
        content: [{ type: "text", text: truncated.content }],
      }
    }
    item.execute = async (initialArgs, opts) => {
      const ctx = context(initialArgs, opts)
      return Mod.toolCall(
        {
          tool: key,
          sessionID: ctx.sessionID,
          agent: ctx.agent,
          messageID: ctx.messageID,
          callID: opts.toolCallId,
          args: initialArgs as Record<string, unknown>,
        },
        (callArgs) => raw(callArgs as typeof initialArgs, opts),
        (text) =>
          ({ title: "", metadata: { truncated: false }, output: text, content: [{ type: "text", text }] }) as Awaited<
            ReturnType<typeof raw>
          >,
        ctx.abort,
      )
    }
    item.toModelOutput = (result) => {
      return {
        type: "text",
        value: result.output,
      }
    }
    tools[key] = item
  }

  // Emit tools in canonical name order so semantically equivalent sets produce
  // byte-identical tool arrays regardless of registration order. Registry, MCP
  // and connector tools are collected by insertion order above, and MCP servers
  // connect in a nondeterministic order — without this sort the provider tool
  // array shifts between runs. Tool definitions sit ahead of system and message
  // blocks in the provider cache prefix, so any reordering invalidates every
  // downstream prompt-cache breakpoint. See opencode #38590.
  return {
    tools: Object.fromEntries(
      Object.entries(tools).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    ),
    deferred: new Set<string>(),
  }
}

export function createStructuredOutputTool(input: {
  schema: Record<string, unknown>
  onSuccess: (output: unknown) => void
}): AITool {
  const { $schema: _$schema, ...toolSchema } = input.schema

  return tool({
    id: "StructuredOutput" as `${string}.${string}`,
    description: STRUCTURED_OUTPUT_DESCRIPTION,
    inputSchema: jsonSchema(toolSchema as Parameters<typeof jsonSchema>[0]),
    async execute(args) {
      input.onSuccess(args)
      return {
        output: "Structured output captured successfully.",
        title: "Structured Output",
        metadata: { valid: true },
      }
    },
    toModelOutput(result) {
      return {
        type: "text",
        value: result.output,
      }
    },
  })
}
