import { Option } from "effect"
import { Runtime } from "../framework/runtime"
import { passthrough } from "../framework/args"
import { Commands } from "../commands"
import path from "path"
import { UI } from "@/cli/ui"
import { Flag } from "@ragu/util/flag"
import { bootstrap } from "@/cli/bootstrap"
import { Command } from "@/command"
import { EOL } from "os"
import { pathToFileURL } from "url"
import { isHeadless, resolvePermissionPrompt } from "@/cli/headless"
import { armExitWatchdog } from "@/cli/exit-watchdog"
import { createRaguClient, type Event as SdkEvent, type RaguClient } from "@ragu/sdk/httpapi"
import { Server } from "@/server/server"
import { Provider } from "@/provider/provider"
import { Agent } from "@/agent/agent"
import { InstanceReload } from "@/project/reload"
import { CacheKeeper } from "@/session/cache-keeper"
import { Config } from "@/config/config"
import { runPromiseWithLayer, withCurrentInstance } from "@/effect"
import { Effect } from "effect"
import { Log } from "@ragu/util/log"

export const log = Log.create({ service: "run-command" })

// `run` has no one at the other end: tools that stop to ask a human (`question`, and the
// plan-mode switches, which confirm through it) are denied for every pattern so they never
// reach the model's schema. Shared by the local and `--attach` session creation.
export const HEADLESS_PERMISSION = ["question", "plan_enter", "plan_exit"].map((permission) => ({
  permission,
  action: "deny" as const,
  pattern: "*",
}))

export const TOOL = new Map<string, [string, string]>(
  Object.entries({
    todowrite: ["Todo", UI.Style.TEXT_WARNING_BOLD],
    todoread: ["Todo", UI.Style.TEXT_WARNING_BOLD],
    bash: ["Bash", UI.Style.TEXT_DANGER_BOLD],
    edit: ["Edit", UI.Style.TEXT_SUCCESS_BOLD],
    glob: ["Glob", UI.Style.TEXT_INFO_BOLD],
    grep: ["Grep", UI.Style.TEXT_INFO_BOLD],
    list: ["List", UI.Style.TEXT_INFO_BOLD],
    read: ["Read", UI.Style.TEXT_HIGHLIGHT_BOLD],
    write: ["Write", UI.Style.TEXT_SUCCESS_BOLD],
    websearch: ["Search", UI.Style.TEXT_DIM_BOLD],
    webfetch: ["Fetch", UI.Style.TEXT_DIM_BOLD],
    codesearch: ["Code", UI.Style.TEXT_DIM_BOLD],
    task: ["Task", UI.Style.TEXT_INFO_BOLD],
    monitor: ["Monitor", UI.Style.TEXT_DANGER_BOLD],
    apply_patch: ["Patch", UI.Style.TEXT_SUCCESS_BOLD],
    multiedit: ["Edit", UI.Style.TEXT_SUCCESS_BOLD],
    tree: ["Tree", UI.Style.TEXT_INFO_BOLD],
    browser_control: ["Browser", UI.Style.TEXT_INFO_BOLD],
    computer: ["Computer", UI.Style.TEXT_INFO_BOLD],
    skill: ["Skill", UI.Style.TEXT_HIGHLIGHT_BOLD],
    lsp: ["LSP", UI.Style.TEXT_INFO_BOLD],
    delegation: ["Delegate", UI.Style.TEXT_INFO_BOLD],
    delegator: ["Delegator", UI.Style.TEXT_INFO_BOLD],
    search_tools: ["Tools", UI.Style.TEXT_DIM_BOLD],
    memory_search: ["Memory", UI.Style.TEXT_DIM_BOLD],
    generate_image: ["Image", UI.Style.TEXT_HIGHLIGHT_BOLD],
    speak: ["Speak", UI.Style.TEXT_DIM_BOLD],
    question: ["Question", UI.Style.TEXT_WARNING_BOLD],
    repo_clone: ["Repo", UI.Style.TEXT_INFO_BOLD],
    repo_overview: ["Repo", UI.Style.TEXT_INFO_BOLD],
    exec_code: ["Exec", UI.Style.TEXT_DANGER_BOLD],
    code_mode: ["Exec", UI.Style.TEXT_WARNING_BOLD],
    plan_enter: ["Plan", UI.Style.TEXT_WARNING_BOLD],
    plan_exit: ["Plan", UI.Style.TEXT_WARNING_BOLD],
    advisor: ["Advisor", UI.Style.TEXT_HIGHLIGHT_BOLD],
    context_collect: ["Context", UI.Style.TEXT_DIM_BOLD],
    context_related: ["Context", UI.Style.TEXT_DIM_BOLD],
    context_diagnostics: ["Context", UI.Style.TEXT_DIM_BOLD],
  } satisfies Record<string, [string, string]>),
)

export function commandGet(name: string) {
  return runPromiseWithLayer(
    Command.defaultLayer,
    withCurrentInstance(
      Effect.gen(function* () {
        const command = yield* Command.Service
        return yield* command.get(name)
      }),
    ),
  )
}

export function configGet() {
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

export function agentGet(name: string) {
  return runPromiseWithLayer(
    Agent.defaultLayer,
    withCurrentInstance(
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        return yield* agent.get(name)
      }),
    ),
  )
}

export function invalidSessionReference(): never {
  UI.error("Invalid --session value. Use a `ses_...` session ID.")
  process.exit(1)
}

/**
 * The per-event fields `--format json` merges into a line, beside the common
 * `type` / `timestamp` / `sessionID`. Derived from the SDK event union so a
 * changed event body fails here instead of silently reshaping the output.
 */
export type RunJsonFields =
  | {
      part: Extract<SdkEvent, { type: "message.part.updated" }>["properties"]["part"]
    }
  | {
      error: NonNullable<Extract<SdkEvent, { type: "session.error" }>["properties"]["error"]>
    }

export type ExecuteTurnInput = {
  sdk: RaguClient
  sessionID: string
  message: string
  command?: string
  agent?: string
  model?: string
  variant?: string
  format: "default" | "json"
  fileParts?: Array<{
    type: "file"
    url: string
    filename: string
    mime: string
  }>
  /** When true (the `ragu run` default), a session error exits the process. */
  exitOnError?: boolean
}

export async function executeTurn(input: ExecuteTurnInput): Promise<{ error?: string }> {
  const { sdk, sessionID, message } = input
  const fileParts = input.fileParts ?? []
  log.debug("Executing session", { sessionID })

  const printEvent = (color: string, type: string, title: string) => {
    UI.println(
      color + "|",
      UI.Style.TEXT_NORMAL + UI.Style.TEXT_DIM + ` ${type.padEnd(7, " ")}`,
      "",
      UI.Style.TEXT_NORMAL + title,
    )
  }

  const outputJsonEvent = (type: string, data: RunJsonFields) => {
    if (input.format === "json") {
      process.stdout.write(
        JSON.stringify({
          type,
          timestamp: Date.now(),
          sessionID,
          ...data,
        }) + EOL,
      )
      return true
    }
    return false
  }

  const events = await sdk.event.subscribe()
  let errorMsg: string | undefined

  const eventProcessor = (async () => {
    for await (const event of events.stream) {
      if (event.type === "message.part.updated") {
        const part = event.properties.part
        if (part.sessionID !== sessionID) continue

        // A failed call is a call too: without this the JSON stream shows only the ones that worked, and every
        // consumer (the bench's tool counts, a failure analysis) sees an error-free run.
        if (part.type === "tool" && part.state.status === "error") {
          if (outputJsonEvent("tool_use", { part })) continue
        }

        if (part.type === "tool" && part.state.status === "completed") {
          if (outputJsonEvent("tool_use", { part })) continue
          const [tool, color] = TOOL.get(part.tool) ?? [part.tool, UI.Style.TEXT_INFO_BOLD]
          const title =
            part.state.title ||
            (Object.keys(part.state.input).length > 0 ? JSON.stringify(part.state.input) : "Unknown")
          printEvent(color, tool, title)
          if (part.tool === "bash" && part.state.output?.trim()) {
            UI.println()
            UI.println(part.state.output)
          }
        }

        if (part.type === "step-start") {
          if (outputJsonEvent("step_start", { part })) continue
        }

        if (part.type === "step-finish") {
          if (outputJsonEvent("step_finish", { part })) continue
        }

        if (part.type === "text" && part.time?.end) {
          if (outputJsonEvent("text", { part })) continue
          const isPiped = !process.stdout.isTTY
          if (!isPiped) UI.println()
          process.stdout.write((isPiped ? part.text : UI.markdown(part.text)) + EOL)
          if (!isPiped) UI.println()
        }
      }

      if (event.type === "session.error") {
        const props = event.properties
        if (props.sessionID !== sessionID || !props.error) continue
        const err = props.error.name === "MessageOutputLengthError" ? props.error.name : props.error.data.message
        errorMsg = errorMsg ? errorMsg + EOL + err : err
        if (outputJsonEvent("error", { error: props.error })) continue
        UI.error(err)
      }

      if (event.type === "session.idle" && event.properties.sessionID === sessionID) {
        break
      }

      if (event.type === "permission.asked") {
        const permission = event.properties
        if (permission.sessionID !== sessionID) continue
        // Auto mode handed this decision back after repeated denials. A headless
        // run has nobody to answer, so the action does not run — but the turn
        // keeps going: a reply with feedback lets the agent continue, where a
        // bare rejection would stop it.
        if (permission.metadata?.["auto_mode"] && !Flag.autoApprove() && isHeadless()) {
          UI.error(`Auto mode blocked ${permission.permission} (${permission.patterns.join(", ")}) repeatedly.`)
          await sdk.permission.reply({
            requestID: permission.id,
            reply: "reject",
            message:
              "Auto mode blocked this action repeatedly and no one is available to approve it. Do not retry it; continue with work that does not need it.",
          })
          continue
        }
        const response = await resolvePermissionPrompt({
          permission: permission.permission,
          patterns: permission.patterns,
          always: permission.always,
        })
        await sdk.permission.respond({
          sessionID,
          permissionID: permission.id,
          response,
        })
      }
    }
  })().catch((error) => {
    // Stream failures must surface through the normal error path: the
    // processor is only awaited later, after the prompt round-trips, and an
    // unhandled interim rejection would crash the run instead.
    errorMsg = errorMsg ? errorMsg + EOL + String(error) : String(error)
  })

  const resolvedAgent = await (async () => {
    if (!input.agent) return undefined
    const agent = await agentGet(input.agent)
    if (!agent) {
      UI.println(
        UI.Style.TEXT_WARNING_BOLD + "!",
        UI.Style.TEXT_NORMAL,
        `agent "${input.agent}" not found. Falling back to default agent`,
      )
      return undefined
    }
    if (agent.mode === "subagent") {
      UI.println(
        UI.Style.TEXT_WARNING_BOLD + "!",
        UI.Style.TEXT_NORMAL,
        `agent "${input.agent}" is a subagent, not a primary agent. Falling back to default agent`,
      )
      return undefined
    }
    return input.agent
  })()

  if (input.command) {
    await sdk.session.command({
      sessionID,
      agent: resolvedAgent,
      model: input.model,
      command: input.command,
      arguments: message,
      variant: input.variant,
    })
  } else {
    const modelParam = input.model ? Provider.parseModel(input.model) : undefined
    await sdk.session.prompt({
      sessionID,
      agent: resolvedAgent,
      model: modelParam,
      variant: input.variant,
      parts: [...fileParts, { type: "text", text: message }],
    })
  }

  await eventProcessor
  if (errorMsg) {
    log.error("Session completed with errors", {
      sessionID,
      error: errorMsg,
    })
    if (input.exitOnError !== false) process.exit(1)
    return { error: errorMsg }
  }
  return {}
}

/**
 * The body of `ragu run`, callable on its own.
 *
 * `goal` runs the same thing with a synthesised message, which under yargs it did
 * by calling `RunCommand.handler`. There is no command object any more, so the
 * body is the export and the handler is a thin caller.
 */
export async function runWithArgs(args: any): Promise<void> {
  log.debug("Run command started", {
    hasMessage: args.message.length > 0,
    hasCommand: Boolean(args.command),
    hasSession: Boolean(args.session),
    hasAttach: Boolean(args.attach),
  })

  let message = [...args.message, ...(args["--"] || [])]
    .map((arg: string) => (arg.includes(" ") ? `"${arg.replace(/"/g, '\\"')}"` : arg))
    .join(" ")

  const fileParts: Array<{
    type: "file"
    url: string
    filename: string
    mime: string
  }> = []

  if (args.file) {
    const files = Array.isArray(args.file) ? args.file : [args.file]

    for (const filePath of files) {
      const resolvedPath = path.resolve(process.cwd(), filePath)
      const file = Bun.file(resolvedPath)

      try {
        const exists = await file.exists()
        if (!exists) {
          UI.error(`File not found: ${filePath}`)
          process.exit(1)
        }

        const stat = await file.stat()
        const mime = stat.isDirectory() ? "application/x-directory" : "text/plain"

        fileParts.push({
          type: "file",
          url: pathToFileURL(resolvedPath).href,
          filename: path.basename(resolvedPath),
          mime,
        })
      } catch (error) {
        log.error("Failed to process file", { filePath, error })
        UI.error(`File not found: ${filePath}`)
        process.exit(1)
      }
    }
  }

  if (!process.stdin.isTTY) {
    try {
      const stdinText = await Bun.stdin.text()
      message += "\n" + stdinText
    } catch (error) {
      log.debug("Failed to read stdin", { error })
    }
  }

  if (message.trim().length === 0 && !args.command) {
    UI.error("You must provide a message or a command")
    process.exit(1)
  }

  const execute = async (sdk: RaguClient, sessionID: string) =>
    executeTurn({
      sdk,
      sessionID,
      message,
      command: args.command,
      agent: args.agent,
      model: args.model,
      variant: args.variant,
      format: args.format,
      fileParts,
    })

  if (args.attach) {
    log.debug("Attaching to remote server", { url: args.attach })
    // The credentials that server expects, and — for the shared service, which
    // has no directory of its own — the directory this command runs in.
    const { BackgroundService } = await import("@/service/service")
    const connection = await BackgroundService.connection(args.attach)
    const sdk = createRaguClient({
      baseUrl: args.attach,
      fetch: connection.fetch,
      directory: connection.service ? process.cwd() : undefined,
    })

    const sessionID = await (async () => {
      if (args.continue) {
        const result = await sdk.session.list()
        return result.data?.find((s) => !s.parentID)?.id
      }
      if (args.session) {
        if (!args.session.startsWith("ses_")) invalidSessionReference()
        return args.session
      }

      const title =
        args.title !== undefined
          ? args.title === ""
            ? message.slice(0, 50) + (message.length > 50 ? "..." : "")
            : args.title
          : undefined

      const result = await sdk.session.create(
        title ? { title, permission: HEADLESS_PERMISSION } : { permission: HEADLESS_PERMISSION },
      )
      return result.data?.id
    })()

    if (!sessionID) {
      UI.error("Session not found")
      process.exit(1)
    }

    // `runWithArgs` is `Promise<void>`, and `executeTurn` already exits the
    // process on error unless the caller opts out with `exitOnError: false`.
    // The envelope is for embedded callers; here it is always `{}` or
    // unreachable. Matches the sibling call site below.
    await execute(sdk, sessionID)
    // The work is done and `bootstrap`'s `finally` has disposed the instance, so the
    // process should now fall off the end of the event loop. Arm the watchdog *after*
    // that, so its timer only exists once there is nothing left to do, and `unref()` it
    // so a clean exit never waits on it. It fires only if something is still holding
    // the loop open — which is the one failure the benchmark could not otherwise
    // diagnose, because the process was killed before it could say anything.
    // Not the TUI: this is the `run` command, and the timer is inert there.
    armExitWatchdog()
    return
  }

  // A one-shot headless run has nothing to reload: the config cannot change
  // under a process that ends with its turn, and `fs.watch` keeps a directory
  // handle open past dispose on Windows. `--attach` returned above, so the
  // remote server that owns the config still watches it; the TUI never
  // reaches this handler.
  if (isHeadless()) InstanceReload.disableForHeadlessRun()
  // A run ends with its turn: nothing in it is left idle for a cache entry to be kept alive for. (It reads events from its own
  // in-process server, so an attached client alone would not tell it apart from a TUI.)
  CacheKeeper.disableForProcess()

  await bootstrap(process.cwd(), async (instance) => {
    log.debug("Running local ragu session")

    const sdk = createRaguClient({
      baseUrl: "http://ragu.local",
      fetch: Server.localFetch,
    })

    if (args.command) {
      const exists = await commandGet(args.command)
      if (!exists) {
        UI.error(`Command "${args.command}" not found`)
        process.exit(1)
      }
    }

    const sessionID = await (async () => {
      if (args.continue) {
        const result = await sdk.session.list()
        return result.data?.find((s) => !s.parentID)?.id
      }
      if (args.session) {
        if (!args.session.startsWith("ses_")) invalidSessionReference()
        return args.session
      }

      const title =
        args.title !== undefined
          ? args.title === ""
            ? message.slice(0, 50) + (message.length > 50 ? "..." : "")
            : args.title
          : undefined

      // Same rule as the --attach branch: without it the local session carries no permission at
      // all, so the tools stay in the model's schema and a call parks for the 600s tool timeout.
      const result = await sdk.session.create(
        title ? { title, permission: HEADLESS_PERMISSION } : { permission: HEADLESS_PERMISSION },
      )
      return result.data?.id
    })()

    if (!sessionID) {
      UI.error("Session not found")
      process.exit(1)
    }

    await execute(sdk, sessionID)
    // The work is done. Arm the watchdog before the instance is disposed, not after: a hang inside
    // the dispose (a language server, monitor or plugin that never stops) would otherwise never
    // reach a line placed after `bootstrap`. The timer is unref'd, so a clean exit never waits on it.
    armExitWatchdog()
  })
}

export default Runtime.handler(Commands.commands["run"], async (input) => {
  const args = {
    _: [],
    $0: "ragu",
    "--": passthrough(),
    message: input["message"],
    command: Option.getOrUndefined(input["command"]),
    continue: Option.getOrUndefined(input["continue"]),
    session: Option.getOrUndefined(input["session"]),
    model: Option.getOrUndefined(input["model"]),
    agent: Option.getOrUndefined(input["agent"]),
    format: input["format"],
    file: input["file"],
    title: Option.getOrUndefined(input["title"]),
    attach: Option.getOrUndefined(input["attach"]),
    port: Option.getOrUndefined(input["port"]),
    variant: Option.getOrUndefined(input["variant"]),
  }
  await runWithArgs(args)
})
