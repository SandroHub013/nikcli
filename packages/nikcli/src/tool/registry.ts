import { plugin } from "bun"
import type { ToolAttachment } from "@nikcli-ai/plugin"
import { QuestionTool } from "./question"
import { BashTool } from "./bash"
import { MonitorTool } from "./monitor"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { BatchTool } from "./batch"
import { ReadTool } from "./read"
import { MultiEditTool } from "./multiedit"
import { Voice as VoiceTool } from "./voice"
import { TaskTool } from "./task"
import { TodoWriteTool, TodoReadTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
import type { Agent } from "../agent/agent"
import { Tool } from "./tool"
import { Config } from "../config/config"
import { PermissionRuleset } from "../permission/ruleset"
import { Wildcard } from "@/util/wildcard"
import path from "path"
import { existsSync } from "fs"
import { type ToolDefinition } from "@nikcli-ai/plugin"
import z from "zod"
import { Plugin } from "../plugin"
import { WebSearchTool } from "./websearch"
import { CodeSearchTool } from "./codesearch"
import { RepoCloneTool } from "./repo_clone"
import { RepoOverviewTool } from "./repo_overview"
import { TreeTool } from "./tree"
import { ContextCollectTool } from "./context_collect"
import { ContextRelatedTool } from "./context_related"
import { ContextDiagnosticsTool } from "./context_diagnostics"
import { MemorySearchTool } from "./memory_search"
import { GenerateImageTool } from "./generate_image"
import { ArtifactTool } from "./artifact"
import { Flag } from "@nikcli-ai/util/flag"
import { Log } from "@nikcli-ai/util/log"
import { LspTool } from "./lsp"
import { InstanceState, locallyInstance, runPromiseWithLayer, type InstanceContext } from "@/effect"
import { Context, Effect, Layer } from "effect"
import { PlanExitTool, PlanEnterTool } from "./plan"
import { ApplyPatchTool } from "./apply_patch"
import { SpeakTool } from "./speak"
import { OpenTUIVizTool } from "./opentui"
import { PluginTool } from "./plugin"
import { DelegationTool } from "./delegation"
import { AdvisorTool } from "./advisor"
import { DelegatorTool } from "./delegator"
import { CodeModeTool } from "./code_mode"
import { SearchToolsTool } from "./search_tools"
import { CreateGoalTool, GetGoalTool, UpdateGoalTool } from "./goal"
import { BrowserControlTool } from "./browser-control"
import { ComputerTool } from "./computer"

const _toolDir = import.meta.dir

plugin({
  name: "nikcli-plugin-resolver",
  setup(build) {
    build.onResolve({ filter: /^@nikcli-ai\/plugin/ }, (args) => {
      try {
        return { path: Bun.resolveSync(args.path, _toolDir) }
      } catch {
        return undefined
      }
    })
  },
})

export namespace ToolRegistry {
  const log = Log.create({ service: "tool.registry" })

  /**
   * Locale-independent id comparison. `localeCompare` orders differently depending on
   * the host locale, which would make the same tool set serialize to different bytes
   * on different machines and defeat the point of sorting at all.
   */
  export function compareIds(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0
  }

  /**
   * The registry tools an open-ended agent gets in its **first** request.
   *
   * Every other registry tool is deferred: its schema stays out of the prompt,
   * `search_tools` lists it by name and one-line summary, and it joins the
   * toolset for the rest of the session once `search_tools` loads it or the
   * model calls it by name. Tool schemas are the first and largest block of the
   * provider prompt, so each tool here is paid for on every request of every
   * session — it has to earn that by being used in most of them, or by being
   * something the system prompt tells the model to reach for unprompted:
   *
   * - the edit loop: `read`, `edit`/`write` (`apply_patch` for GPT), `bash`,
   *   `glob`, `grep`;
   * - how the agent organises its work: `task`, `todowrite`, `skill`,
   *   `question`, and `search_tools` itself;
   * - tools the primary agents' prompts name as the way to do something:
   *   `monitor` (long-running commands), `delegation` (background results),
   *   `plan_enter`/`plan_exit`, and the goal tools the `/goal`, mission and
   *   loop prompts call;
   * - tools that only exist because config opted in to them for exactly this
   *   use: `advisor` (`agent.advisor`), `batch` (`experimental.batch_tool`).
   *
   * `invalid` is here so it is never offered for loading; the model does not
   * see it either way.
   *
   * `config.tool.eager` adds to this set; MCP and connector tools are not
   * registry tools and are not deferred.
   */
  export const CORE: ReadonlySet<string> = new Set([
    "invalid",
    "read",
    "edit",
    "write",
    "apply_patch",
    "bash",
    "glob",
    "grep",
    "task",
    "todowrite",
    "skill",
    "question",
    "search_tools",
    "monitor",
    "delegation",
    "plan_enter",
    "plan_exit",
    "create_goal",
    "get_goal",
    "update_goal",
    "advisor",
    "batch",
  ])

  /**
   * Whether the ruleset hands the agent a curated toolset: anything it does not
   * name is denied. Subagents like `scout` or `explore` are built this way, and
   * everything they can see is what their prompt tells them to use — deferring
   * any of it would only add a round trip to their main job, so nothing is
   * deferred for them.
   */
  export function curated(ruleset: PermissionRuleset.Ruleset): boolean {
    const fallback = ruleset.findLast((rule) => rule.permission === "*")
    return fallback?.action === "deny" && fallback.pattern === "*"
  }

  /**
   * How a registry tool reaches the model:
   *
   * - `active` — schema in every request;
   * - `deferred` — callable, and listed by `search_tools`, but its schema is
   *   left out of the request until it is loaded;
   * - `hidden` — not offered at all.
   */
  export type Exposure = "active" | "deferred" | "hidden"

  /**
   * Where a registry tool stands for one session, on top of the
   * model/agent/flag filters {@link Interface.tools} already applies.
   *
   * `session.disabledTools` is tri-state: `true` is the user switching a tool
   * off, `false` is a deferred tool that has been loaded — by `search_tools`,
   * by a direct call, or by the `/usage` toggle — and an absent entry is the
   * default for the tool.
   *
   * Shared on purpose. `resolveTools` uses it to build the toolset the model
   * receives, `search_tools` to build the catalog it offers and `/usage` to
   * report what is in context; if they drifted, `search_tools` would offer a
   * tool the session will not run.
   */
  export function exposure(
    id: string,
    input: {
      disabledTools?: Record<string, boolean>
      ruleset: PermissionRuleset.Ruleset
      /** `config.tool.eager`: ids or wildcards loaded from the first request. */
      eager?: readonly string[]
    },
  ): Exposure {
    if (!visible(id, input)) return "hidden"
    if (CORE.has(id)) return "active"
    if (input.disabledTools?.[id] === false) return "active"
    if (input.eager?.some((pattern) => Wildcard.match(id, pattern))) return "active"
    if (curated(input.ruleset)) return "active"
    return "deferred"
  }

  /**
   * Whether the session can use a tool at all — the switch MCP and connector
   * tools go through, and the `hidden` half of {@link exposure}.
   */
  export function visible(
    id: string,
    input: {
      disabledTools?: Record<string, boolean>
      ruleset: PermissionRuleset.Ruleset
    },
  ): boolean {
    // Tools the user switched off for this session.
    if (input.disabledTools?.[id] === true) return false
    // Wholly-denied tools (pattern "*"). Resource-scoped denies stay visible —
    // the tool still works on the paths that are allowed.
    if (PermissionRuleset.disabled([id], input.ruleset).has(id)) return false
    return true
  }

  type DerivedState = {
    readonly tools: Tool.Info[]
  }

  type RuntimeEntry = {
    readonly token: number
    readonly tool: Tool.Info
  }

  type RuntimeState = {
    entries: RuntimeEntry[]
    nextToken: number
  }

  /**
   * Last registration for an id wins. Built-ins, then config-dir/plugin tools,
   * then runtime `register()` entries — closing a handle reveals the previous
   * occupant of that id.
   */
  export function lastWins<T extends { id: string }>(tools: readonly T[]): T[] {
    const map = new Map<string, T>()
    for (const tool of tools) map.set(tool.id, tool)
    return [...map.values()]
  }

  export type Handle = {
    readonly close: Effect.Effect<void>
  }

  export type Resolved = {
    id: string
    description: string
    parameters: z.ZodType
    output?: z.ZodType
    execute: Tool.Def["execute"]
    executeAsync: Tool.Def["executeAsync"]
    formatValidationError: Tool.Def["formatValidationError"]
  }

  export interface Interface {
    readonly register: (tool: Tool.Info) => Effect.Effect<Handle>
    readonly ids: () => Effect.Effect<string[], unknown>
    readonly tools: (
      model: {
        providerID: string
        modelID: string
      },
      agent?: Agent.Info,
      options?: { exclude?: ReadonlySet<string> },
    ) => Effect.Effect<Resolved[], unknown>
  }

  export class Service extends Context.Service<Service, Interface>()("@nikcli/ToolRegistry") {}

  function configGet(ctx: InstanceContext) {
    return runPromiseWithLayer(
      Config.defaultLayer,
      locallyInstance(
        ctx,
        Effect.gen(function* () {
          const config = yield* Config.Service
          return yield* config.get()
        }),
      ),
    )
  }

  function configDirectories(ctx: InstanceContext) {
    return runPromiseWithLayer(
      Config.defaultLayer,
      locallyInstance(
        ctx,
        Effect.gen(function* () {
          const config = yield* Config.Service
          return yield* config.directories()
        }),
      ),
    )
  }

  function isToolPathAllowed(filePath: string, allowlist: string[]): boolean {
    const base = path.basename(filePath)
    const name = path.basename(filePath, path.extname(filePath))
    return allowlist.some((entry) => entry === filePath || entry === base || entry === name)
  }

  async function sha256File(filePath: string): Promise<string> {
    const hasher = new Bun.CryptoHasher("sha256")
    hasher.update(await Bun.file(filePath).arrayBuffer())
    return hasher.digest("hex")
  }

  /** Test/docs seam: whether config-dir `{tool,tools}/*` should be scanned. */
  export function shouldScanCustomTools(input: { allowAutoloadFlag: boolean; allowlist: readonly string[] }): boolean {
    return input.allowAutoloadFlag || input.allowlist.length > 0
  }

  /** Test/docs seam: allowlist match for a candidate tool file. */
  export function isCustomToolAllowed(filePath: string, allowlist: readonly string[]): boolean {
    return isToolPathAllowed(filePath, [...allowlist])
  }

  /**
   * Test/docs seam: the pin `config.tool.pin` declares for a candidate file,
   * looked up by absolute path, then basename, then namespace. `undefined`
   * means unpinned, which is loadable — the autoload gate, not the pin, is
   * what keeps an unconfigured environment from running these at all.
   */
  export function customToolPin(pins: Record<string, string>, filePath: string): string | undefined {
    const base = path.basename(filePath)
    const namespace = path.basename(filePath, path.extname(filePath))
    return pins[filePath] ?? pins[base] ?? pins[namespace]
  }

  /**
   * Test/docs seam: whether a pinned file may be imported. Fail-closed — a
   * declared pin that does not match the file on disk refuses the load. The
   * expected hash is compared case-insensitively because a pin is copied by
   * hand out of `shasum` output as often as out of this codebase.
   */
  export function isCustomToolPinSatisfied(expected: string | undefined, actual: string): boolean {
    if (!expected) return true
    return actual.toLowerCase() === expected.toLowerCase()
  }

  function fromPlugin(id: string, def: ToolDefinition): Tool.Info {
    return Tool.define(id, async () => ({
      parameters: z.object(def.args),
      description: def.description,
      execute: async (args, ctx): Promise<Tool.Result<{}>> => {
        const result = await def.execute(args as any, ctx)
        if (typeof result !== "string") {
          return {
            title: result.title ?? "",
            output: result.output,
            metadata: result.metadata ?? {},
            attachments: (result.attachments as ToolAttachment[])?.map((a) => ({
              id: ctx.messageID,
              sessionID: ctx.sessionID,
              messageID: ctx.messageID,
              type: a.type,
              mime: a.mime,
              url: a.url,
              filename: a.filename,
            })),
          }
        }
        return {
          title: "",
          output: result,
          metadata: {},
        }
      },
    }))
  }

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const derived = yield* InstanceState.make<DerivedState>(
        Effect.fn("ToolRegistry.derived")(function* () {
          const tools = [] as Tool.Info[]
          const glob = new Bun.Glob("{tool,tools}/*.{js,ts}")
          const ctx = yield* InstanceState.context
          const config = yield* Effect.promise(() => configGet(ctx))
          const allowlist = config.tool?.allow ?? []
          const pins = config.tool?.pin ?? {}
          const autoloadEnabled = Flag.NIKCLI_ALLOW_PLUGIN_AUTOLOAD || allowlist.length > 0

          if (!autoloadEnabled) {
            log.info("skipping config-dir tool autoload", {
              reason: "NIKCLI_ALLOW_PLUGIN_AUTOLOAD unset and tool.allow empty",
            })
          } else {
            for (const dir of yield* Effect.promise(() => configDirectories(ctx))) {
              // The config dir may not exist yet; scanning a missing dir throws ENOENT.
              if (!existsSync(dir)) continue
              const matches = yield* Effect.promise(() =>
                Array.fromAsync(
                  glob.scan({
                    cwd: dir,
                    absolute: true,
                    followSymlinks: false,
                    dot: true,
                  }),
                ),
              )
              for (const match of matches) {
                const namespace = path.basename(match, path.extname(match))
                if (allowlist.length > 0 && !isToolPathAllowed(match, allowlist)) {
                  log.warn("skipping custom tool (not in tool.allow)", {
                    path: match,
                  })
                  continue
                }
                const expectedHash = customToolPin(pins, match)
                if (expectedHash) {
                  const actual = yield* Effect.promise(() => sha256File(match))
                  if (!isCustomToolPinSatisfied(expectedHash, actual)) {
                    log.error("custom tool hash mismatch; refusing to load", {
                      path: match,
                      expected: expectedHash,
                      actual,
                    })
                    continue
                  }
                }

                const mod = yield* Effect.promise(() => import(match))
                for (const [id, def] of Object.entries<ToolDefinition>(mod)) {
                  tools.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
                }
              }
            }
          }

          const plugins = yield* Effect.provide(
            Effect.gen(function* () {
              const plugin = yield* Plugin.Service
              return yield* plugin.list()
            }),
            Plugin.defaultLayer,
          ).pipe(Effect.orDie)
          for (const plugin of plugins) {
            for (const [id, def] of Object.entries(plugin.tool ?? {})) {
              tools.push(fromPlugin(id, def))
            }
          }

          return { tools }
        }),
        // Config-dir files and plugin.tool contributions are a derivation of
        // disk + loaded plugins, so they join instance hot reload. Runtime
        // `register()` lives in the cache below and is not opted in.
        { reloadable: true },
      )

      const runtime = yield* InstanceState.make<RuntimeState>(() =>
        Effect.succeed({ entries: [] as RuntimeEntry[], nextToken: 1 }),
      )

      const register: Interface["register"] = Effect.fn("ToolRegistry.register")(function* (tool: Tool.Info) {
        const state = yield* InstanceState.get(runtime)
        const token = state.nextToken++
        state.entries.push({ token, tool })
        return {
          close: Effect.gen(function* () {
            const current = yield* InstanceState.get(runtime)
            const idx = current.entries.findIndex((entry) => entry.token === token)
            if (idx >= 0) current.entries.splice(idx, 1)
          }),
        } satisfies Handle
      })

      const all: () => Effect.Effect<Tool.Info[], unknown> = Effect.fn("ToolRegistry.all")(function* () {
        const contributed = yield* InstanceState.get(derived).pipe(Effect.map((x) => x.tools))
        const registered = yield* InstanceState.get(runtime).pipe(Effect.map((x) => x.entries))
        const ctx = yield* InstanceState.context
        const config = yield* Effect.promise(() => configGet(ctx))

        return lastWins([
          InvalidTool,
          ...(["app", "cli", "desktop"].includes(Flag.NIKCLI_CLIENT) ? [QuestionTool] : []),
          BashTool,

          MonitorTool,
          ReadTool,
          TreeTool,
          GlobTool,
          GrepTool,
          EditTool,
          WriteTool,
          MultiEditTool,
          TaskTool,
          DelegationTool,
          ContextCollectTool,
          ContextRelatedTool,
          ContextDiagnosticsTool,
          MemorySearchTool,
          GenerateImageTool,
          ArtifactTool,

          WebFetchTool,
          TodoWriteTool,
          TodoReadTool,
          CreateGoalTool,
          GetGoalTool,
          UpdateGoalTool,
          WebSearchTool,
          CodeSearchTool,
          RepoCloneTool,
          RepoOverviewTool,
          SkillTool,
          ApplyPatchTool,
          ...(Flag.NIKCLI_EXPERIMENTAL_LSP_TOOL ? [LspTool] : []),
          ...(config.experimental?.batch_tool === true ? [BatchTool] : []),
          // plan_exit / plan_enter are always registered; the agent permission ruleset
          // denies them by default and only the `plan` agent grants `plan_exit: "allow"`.
          // Hiding them behind `NIKCLI_CLIENT === "cli"` would also drop them from the
          // catalog surfaced via `search_tools`, which is wrong.
          PlanExitTool,
          PlanEnterTool,
          SpeakTool,
          VoiceTool,
          OpenTUIVizTool,
          PluginTool,
          AdvisorTool,
          DelegatorTool,
          SearchToolsTool,
          // exec_code (NativeExecutor, unconfined) is deprecated in favor of code_mode.
          ...(Flag.NIKCLI_EXPERIMENTAL_CODE_MODE ? [CodeModeTool] : []),
          ...(Flag.NIKCLI_EXPERIMENTAL_BROWSER_CONTROL_TOOL ? [BrowserControlTool] : []),
          ...(Flag.NIKCLI_EXPERIMENTAL_COMPUTER_TOOL ? [ComputerTool] : []),
          ...contributed,
          ...registered.map((entry) => entry.tool),
        ])
      })

      const ids: Interface["ids"] = Effect.fn("ToolRegistry.ids")(function* () {
        const list = yield* all()
        return list.map((t) => t.id)
      })

      const tools: Interface["tools"] = Effect.fn("ToolRegistry.tools")(function* (
        model: {
          providerID: string
          modelID: string
        },
        agent?: Agent.Info,
        options?: { exclude?: ReadonlySet<string> },
      ) {
        const tools = yield* all()
        // A tool whose definition depends on the project (`bash` names the
        // default working directory in its description) gets the instance
        // here rather than reading the ambient scope from inside `init`.
        const instance = yield* InstanceState.context
        const result = yield* Effect.promise(() =>
          Promise.all(
            tools
              .filter((t) => {
                if (options?.exclude?.has(t.id)) return false

                if (t.id === "codesearch" || t.id === "websearch") {
                  return model.providerID === "nikcli" || Flag.NIKCLI_ENABLE_EXA
                }

                const usePatch =
                  model.modelID.includes("gpt-") && !model.modelID.includes("oss") && !model.modelID.includes("gpt-4")
                if (t.id === "apply_patch") return usePatch
                // The string-replace edit family is the alternative to apply_patch,
                // not an addition to it: a GPT model that got both would be offered
                // two different ways to write the same file.
                if (t.id === "edit" || t.id === "write" || t.id === "multiedit") return !usePatch

                if (t.id === "advisor") return !!agent?.advisor

                return true
              })
              // Canonical order by id. The tool array is the first and largest
              // component of the provider prompt-cache prefix, so an equivalent set of
              // tools must serialize to identical bytes regardless of the order
              // plugins registered them or `register()` appended them.
              .sort((left, right) => compareIds(left.id, right.id))
              .map(async (t) => {
                using _ = log.time(t.id)
                const def = await t.init({ agent, instance })
                return {
                  id: t.id,
                  description: def.description,
                  parameters: def.parameters,
                  output: def.output,
                  execute: def.execute,
                  executeAsync: def.executeAsync,
                  formatValidationError: def.formatValidationError,
                }
              }),
          ),
        )
        return result satisfies Resolved[]
      })

      return Service.of({
        register,
        ids,
        tools,
      })
    }),
  )

  export const defaultLayer = layer
}
