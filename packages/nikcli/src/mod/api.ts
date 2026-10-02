import fs from "fs/promises"
import path from "path"
import { Effect, Scope } from "effect"
import { tool, type ToolDefinition } from "@nikcli-ai/plugin/tool"
import { Global } from "@nikcli-ai/util/global"
import { Log } from "@nikcli-ai/util/log"
import { Filesystem } from "@nikcli-ai/util/filesystem"
import type { InstanceContext } from "@/effect"
import { ModChain } from "./chain"
import { ModUi } from "./ui"

/**
 * The `$` a hook receives: the only way a mod reaches files, processes, the
 * network, the user and nikcli itself.
 *
 * Every call is also an event named for its namespace and method (`fs.read`,
 * `process.run`). A hook on one sees the calls of the mods that run after it
 * and may pass them on, deny them (`{ deny }`) or answer them (`{ value }`) —
 * which is how a policy mod audits or refuses what other mods do. A hook that
 * is waiting on a call is not spending its own time: the call pauses the clock.
 *
 * What is not here yet fails with a named error rather than being absent, so a
 * mod written against the Claude Code mods API says which call nikcli lacks.
 */
export namespace ModApi {
  const log = Log.create({ service: "mod-api" })

  export const NAME = /^[A-Za-z0-9_-]{1,64}$/
  export const FILE_LIMIT = 4 * 1024 * 1024
  export const STORE_LIMIT = 4 * 1024 * 1024
  export const PROCESS_DEFAULT_MS = 30_000
  export const PROCESS_MAX_MS = 10 * 60_000

  /** Calls that exist in the Claude Code mods API and not yet in nikcli. */
  export const UNSUPPORTED = [
    "ui.focus",
    "ui.scroll",
    "ui.status",
    "ui.copy",
    "ui.blit",
    "agent.register",
    "agent.spawn",
    "model.fork",
    "prompt.read",
    "prompt.fill",
    "prompt.suggest",
    "prompt.compose",
    "session.surfaces",
    "session.compact",
    "session.send",
    "session.append",
    "session.authorize",
    "config.list",
    "config.set",
    "mcp.connect",
    "tool.call",
    "tool.check",
    "audio.play",
    "audio.speak",
  ] as const

  export class Unsupported extends Error {
    readonly _tag = "ModApiUnsupported"
    constructor(readonly api: string) {
      super(`$.${api} is not available in nikcli yet`)
    }
  }

  export interface Command {
    name: string
    description?: string
    run: (args: string) => unknown
  }

  /** What the runtime hands a mod's `$`. */
  export interface Host {
    ctx: InstanceContext
    mod: ModChain.Mod
    root?: string
    options: Record<string, unknown>
    /** The mod's own scope: closed on unload and reload, which stops everything it started. */
    scope: Scope.Closeable
    /** Tools this mod registered; the plugin adapter exposes this live object to the tool registry. */
    tools: Record<string, ToolDefinition>
    commands: Map<string, Command & { owner: string }>
    /** Survives a reload, gone with the process. */
    memory: Map<string, unknown>
    /** Fire a mods API call as an event among the mods that run after the caller. */
    emit: (
      name: string,
      event: unknown,
      impl: (event: any) => Promise<unknown>,
    ) => Promise<{ value?: unknown; deny?: string }>
    /** Panes mods have open; this mod's are closed with its scope. */
    panes: Map<string, ModUi.PaneInfo & { owner: string }>
    /** Tell clients the panes changed, or that a site should be drawn again. */
    changed: (kind: "panes" | "invalidate", detail?: { component?: string; requestID?: string }) => void
    /** Run `fn` with this mod's instance as the ambient one: timers and callbacks are outside any. */
    inInstance: <A>(fn: () => Promise<A>) => Promise<A>
  }

  const unsupported = (api: string) => () => {
    throw new Unsupported(api)
  }

  function sizeOf(value: string | Uint8Array) {
    return typeof value === "string" ? Buffer.byteLength(value) : value.byteLength
  }

  export function make(host: Host) {
    const { ctx, mod } = host
    const owned = {
      timers: new Set<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>(),
      procs: new Set<{ kill: (signal?: number | NodeJS.Signals) => void }>(),
    }

    // Everything a mod starts is closed with its scope: a reload must not leave
    // the old generation's timers and processes running beside the new one.
    Effect.runSync(
      Scope.addFinalizer(
        host.scope,
        Effect.sync(() => {
          for (const timer of owned.timers) {
            clearTimeout(timer as ReturnType<typeof setTimeout>)
            clearInterval(timer as ReturnType<typeof setInterval>)
          }
          owned.timers.clear()
          for (const proc of owned.procs) {
            try {
              proc.kill()
            } catch {
              // already gone
            }
          }
          owned.procs.clear()
        }),
      ),
    )

    const resolve = (target: string) => (path.isAbsolute(target) ? target : path.resolve(ctx.directory, target))

    /** A mods API call: an event among the later mods, with the hook's clock stopped meanwhile. */
    const call = async <A>(
      name: string,
      event: Record<string, unknown>,
      impl: (event: any) => Promise<A>,
    ): Promise<A> => {
      const result = await ModChain.paused(() => host.emit(name, event, impl))
      if (result.deny !== undefined) throw new Error(`$.${name} was denied: ${result.deny}`)
      return result.value as A
    }

    const sessionID = () => ModChain.current()?.sessionID

    // ---------------------------------------------------------------- fs
    const filesystem = {
      read: (file: string, options?: { encoding?: "utf8" | "base64" }) =>
        call("fs.read", { path: file, ...options }, async (e) => {
          const target = resolve(e.path)
          const stat = await fs.stat(target)
          if (stat.size > FILE_LIMIT) throw new Error(`${e.path} is larger than ${FILE_LIMIT} bytes`)
          const data = await fs.readFile(target)
          return e.encoding === "base64" ? data.toString("base64") : data.toString("utf8")
        }),
      write: (file: string, content: string | Uint8Array) =>
        call("fs.write", { path: file, content: typeof content === "string" ? content : "(binary)" }, async (e) => {
          if (sizeOf(content) > FILE_LIMIT) throw new Error(`content is larger than ${FILE_LIMIT} bytes`)
          const target = resolve(e.path)
          await fs.mkdir(path.dirname(target), { recursive: true })
          await fs.writeFile(target, content)
        }),
      list: (dir: string) =>
        call("fs.list", { path: dir }, async (e) => {
          const entries = await fs.readdir(resolve(e.path), { withFileTypes: true })
          return entries.map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? "directory" : "file" }))
        }),
      exists: (file: string) => call("fs.exists", { path: file }, (e) => Filesystem.exists(resolve(e.path))),
      stat: (file: string) =>
        call("fs.stat", { path: file }, async (e) => {
          const stat = await fs.stat(resolve(e.path))
          return { size: stat.size, isDirectory: stat.isDirectory(), isFile: stat.isFile(), modifiedMs: stat.mtimeMs }
        }),
      ancestors: (start: string) =>
        call("fs.ancestors", { path: start }, async (e) => {
          const out: string[] = []
          let at = resolve(e.path)
          while (true) {
            out.push(at)
            const parent = path.dirname(at)
            if (parent === at) break
            at = parent
          }
          return out
        }),
    }

    // ----------------------------------------------------------- process
    const processApi = {
      run: (
        command: string[],
        options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; input?: string },
      ) =>
        call("process.run", { command, ...options }, async (e) => {
          if (
            !Array.isArray(e.command) ||
            e.command.length === 0 ||
            e.command.some((part: unknown) => typeof part !== "string")
          ) {
            throw new Error("command must be a non-empty array of strings")
          }
          const timeout = Math.min(Math.max(1, e.timeoutMs ?? PROCESS_DEFAULT_MS), PROCESS_MAX_MS)
          const proc = Bun.spawn(e.command as string[], {
            cwd: e.cwd ? resolve(e.cwd) : ctx.directory,
            env: { ...process.env, ...(e.env as Record<string, string> | undefined) },
            stdin: e.input === undefined ? "ignore" : new TextEncoder().encode(e.input),
            stdout: "pipe",
            stderr: "pipe",
            timeout,
            killSignal: "SIGKILL",
          })
          owned.procs.add(proc)
          try {
            const [stdout, stderr, exitCode] = await Promise.all([
              new Response(proc.stdout).text(),
              new Response(proc.stderr).text(),
              proc.exited,
            ])
            return { exitCode, stdout, stderr, timedOut: proc.signalCode === "SIGKILL" }
          } finally {
            owned.procs.delete(proc)
          }
        }),
      spawn: (command: string[], options?: { cwd?: string; env?: Record<string, string> }) =>
        call("process.spawn", { command, ...options }, async (e) => {
          if (!Array.isArray(e.command) || e.command.length === 0) throw new Error("command must be a non-empty array")
          const proc = Bun.spawn(e.command as string[], {
            cwd: e.cwd ? resolve(e.cwd) : ctx.directory,
            env: { ...process.env, ...(e.env as Record<string, string> | undefined) },
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          })
          owned.procs.add(proc)
          void proc.exited.finally(() => owned.procs.delete(proc))
          return { pid: proc.pid, kill: () => proc.kill(), exited: proc.exited }
        }),
    }

    // -------------------------------------------------------------- http
    // The one outbound network call a mod can make. It is an event like any `$` call, so a policy mod
    // (`on("http.fetch", ...)`) can audit or refuse it; `specs/network-egress.json` lists this file.
    const outbound = (e: { url: string; init?: RequestInit }) => {
      return fetch(e.url, e.init)
    }
    const http = {
      fetch: (url: string, init?: RequestInit) => call("http.fetch", { url, init }, outbound),
    }

    // --------------------------------------------------------------- env
    const env = {
      get: (name: string) => call("env.get", { name }, async (e) => process.env[e.name]),
      set: (name: string, value: string) =>
        call("env.set", { name, value }, async (e) => {
          process.env[e.name] = e.value
        }),
    }

    // ------------------------------------------------------------- clock
    const clock = {
      now: () => Date.now(),
      // The one call that stays on the hook's clock: sleeping is the hook's own time.
      sleep: (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)),
      after: (ms: number, fn: () => unknown) => {
        const timer = setTimeout(() => {
          owned.timers.delete(timer)
          Promise.resolve()
            .then(fn)
            .catch((error) => log.warn("mod timer failed", { mod: mod.name, error: String(error) }))
        }, ms)
        owned.timers.add(timer)
        return { cancel: () => (clearTimeout(timer), owned.timers.delete(timer)) }
      },
      every: (ms: number, fn: () => unknown) => {
        let running = false
        const timer = setInterval(() => {
          // One run at a time: a tick that finds the previous one unfinished is skipped.
          if (running) return
          running = true
          Promise.resolve()
            .then(fn)
            .catch((error) => log.warn("mod timer failed", { mod: mod.name, error: String(error) }))
            .finally(() => (running = false))
        }, ms)
        owned.timers.add(timer)
        return { cancel: () => (clearInterval(timer), owned.timers.delete(timer)) }
      },
    }

    // ------------------------------------------------------------- store
    const storeFile = path.join(Global.Path.data, "mods", mod.name.replace(/[^A-Za-z0-9._-]/g, "_"), "store.json")
    let writing: Promise<unknown> = Promise.resolve()
    const readStore = async (): Promise<Record<string, unknown>> => {
      try {
        return JSON.parse(await fs.readFile(storeFile, "utf8"))
      } catch {
        return {}
      }
    }
    const mutateStore = <A>(change: (data: Record<string, unknown>) => A) => {
      const next = writing.then(async () => {
        const data = await readStore()
        const result = change(data)
        const text = JSON.stringify(data)
        if (Buffer.byteLength(text) > STORE_LIMIT) throw new Error(`the store is larger than ${STORE_LIMIT} bytes`)
        await fs.mkdir(path.dirname(storeFile), { recursive: true })
        const temp = `${storeFile}.${process.pid}.tmp`
        await fs.writeFile(temp, text)
        await fs.rename(temp, storeFile)
        return result
      })
      writing = next.catch(() => undefined)
      return next
    }
    const store = {
      get: (key: string) => call("store.get", { key }, async (e) => (await readStore())[e.key]),
      set: (key: string, value: unknown) =>
        call("store.set", { key, value }, (e) => mutateStore((data) => void (data[e.key] = e.value))),
      delete: (key: string) => call("store.delete", { key }, (e) => mutateStore((data) => void delete data[e.key])),
      keys: () => call("store.keys", {}, async () => Object.keys(await readStore())),
    }

    // ------------------------------------------------------------- state
    const state = {
      get: (key: string) => host.memory.get(key),
      set: (key: string, value: unknown) => void host.memory.set(key, value),
    }

    // ---------------------------------------------------------------- ui
    // A hook may invalidate on every event; clients should hear about it at most 10 times a second.
    let pending: { component?: string; requestID?: string } | undefined
    let invalidateTimer: ReturnType<typeof setTimeout> | undefined
    const invalidate = (detail: { component?: string; requestID?: string }) => {
      // Calls close together widen the target: a different component or request means "everything".
      pending =
        pending === undefined
          ? detail
          : {
              component: pending.component === detail.component ? detail.component : undefined,
              requestID: pending.requestID === detail.requestID ? detail.requestID : undefined,
            }
      if (invalidateTimer) return
      const timer = setTimeout(() => {
        invalidateTimer = undefined
        owned.timers.delete(timer)
        const send = pending
        pending = undefined
        host.changed("invalidate", send)
      }, 100)
      invalidateTimer = timer
      owned.timers.add(timer)
    }
    const ui = {
      log: (text: string, options?: { to?: "transcript" | "debug" }) =>
        call("ui.log", { text, ...options }, async (e) => {
          log.info("mod log", { mod: mod.name, text: e.text })
          if (e.to === "debug") return
          await host.inInstance(async () => {
            const { Bus } = await import("@/bus")
            const { Mod } = await import("./index")
            await Bus.publish(Mod.Event.Log, { plugin: mod.name, sessionID: sessionID(), text: String(e.text) })
          })
        }),
      toast: (text: string, options?: { variant?: "info" | "success" | "warning" | "error"; timeoutMs?: number }) =>
        call("ui.toast", { text, ...options }, async (e) => {
          await host.inInstance(async () => {
            const { Bus } = await import("@/bus")
            const { TuiEvent } = await import("@/bus/tui-event")
            await Bus.publish(TuiEvent.ToastShow, {
              title: mod.name,
              message: String(e.text),
              variant: e.variant ?? "info",
              duration: e.timeoutMs ?? 4000,
            })
          })
        }),
      notice: (text: string) => ui.toast(text, { variant: "info" }),
      /**
       * Ask the user. Resolves to the label picked, or the text typed. Rejects
       * when the question is dismissed, and when there is no session to ask in
       * (a headless run): a hook that holds a call on this must treat that as
       * "no" — the docs' own example starts from the safe answer.
       */
      ask: (question: string, options: string[]) =>
        call("ui.ask", { question, options }, async (e) => {
          const session = sessionID()
          if (!session) throw new Error("there is no session to ask in")
          const labels = (e.options as string[]).map((label) => String(label).slice(0, 30))
          const { Question } = await import("@/question")
          const { runPromiseWithLayer, locallyInstance } = await import("@/effect")
          const answers = await runPromiseWithLayer(
            Question.defaultLayer,
            locallyInstance(
              ctx,
              Effect.gen(function* () {
                const questions = yield* Question.Service
                return yield* questions.ask({
                  sessionID: session,
                  questions: [
                    {
                      question: String(e.question),
                      header: mod.name.slice(0, 30),
                      options: labels.map((label) => ({ label, description: "" })),
                      custom: true,
                    },
                  ],
                })
              }),
            ),
          )
          return answers[0]?.[0] ?? ""
        }),
      /** The constructors for a drawing: `const { Box, Text, Button } = $.ui.resolve(e)`. */
      resolve: (_event?: unknown) => ModUi.builders(),
      /** Ask clients to draw again. Many calls close together become one. */
      invalidate: (component?: string, requestID?: string) => invalidate({ component, requestID }),
      /**
       * Open a pane. `dock` puts it in the sidebar, `inline` above the prompt. Its content is whatever
       * your `ui.render` hook answers for `{ component: "Pane", requestId: id }`.
       */
      open: (input: { id: string; title?: string; placement?: ModUi.Placement; rows?: number }) => {
        if (!NAME.test(input.id)) throw new Error(`pane id must match ${NAME}`)
        const existing = host.panes.get(input.id)
        if (existing && existing.owner !== mod.id) throw new Error(`pane ${input.id} is open by ${existing.plugin}`)
        host.panes.set(input.id, {
          id: input.id,
          plugin: mod.name,
          owner: mod.id,
          title: input.title ?? input.id,
          placement: input.placement ?? "dock",
          rows: input.rows,
        })
        host.changed("panes")
        return { close: () => ui.close(input.id) }
      },
      close: (id: string) => {
        const pane = host.panes.get(id)
        if (!pane || pane.owner !== mod.id) return
        host.panes.delete(id)
        host.changed("panes")
      },
      panes: () =>
        [...host.panes.values()].filter((pane) => pane.owner === mod.id).map(({ owner: _owner, ...pane }) => pane),
      focus: unsupported("ui.focus"),
      scroll: unsupported("ui.scroll"),
      status: unsupported("ui.status"),
      copy: unsupported("ui.copy"),
      blit: unsupported("ui.blit"),
    }

    // ----------------------------------------------------------- command
    const command = {
      register: (input: Command) => {
        if (!NAME.test(input.name)) throw new Error(`command name must match ${NAME}`)
        if (typeof input.run !== "function") throw new Error("command needs a run function")
        const existing = host.commands.get(input.name)
        if (existing && existing.owner !== mod.id)
          throw new Error(`command ${input.name} is registered by ${existing.owner}`)
        host.commands.set(input.name, { ...input, owner: mod.id })
        return { dispose: () => void host.commands.delete(input.name) }
      },
      run: (name: string, args = "") =>
        call("command.run", { name, args }, async (e) => {
          const found = host.commands.get(e.name)
          if (!found) throw new Error(`no mod command named ${e.name}`)
          return found.run(e.args)
        }),
      list: () => [...host.commands.values()].map(({ name, description }) => ({ name, description })),
    }

    // -------------------------------------------------------------- tool
    const toolApi = {
      /** Register a tool the model can call: `{ name, description, args, execute }`, args as zod fields. */
      register: (input: {
        name: string
        description: string
        args: Record<string, any>
        execute: (args: any, context: any) => Promise<any>
      }) => {
        if (!NAME.test(input.name)) throw new Error(`tool name must match ${NAME}`)
        host.tools[input.name] = tool({ description: input.description, args: input.args, execute: input.execute })
        return { dispose: () => void delete host.tools[input.name] }
      },
      list: () => Object.keys(host.tools),
      call: unsupported("tool.call"),
      check: unsupported("tool.check"),
    }

    // ----------------------------------------------------------- session
    const need = (what: string) => {
      const id = sessionID()
      if (!id) throw new Error(`$.${what} needs a session, and no session is running this hook`)
      return id
    }

    /** The newest messages of the running session, oldest first, as plain data. */
    const readMessages = async (id: string, limit: number) => {
      const { MessageV2 } = await import("@/session/message-v2")
      const found: any[] = []
      for await (const item of MessageV2.stream(id)) {
        found.push(item)
        if (found.length >= limit) break
      }
      return found.reverse()
    }

    const session = {
      id: () => sessionID(),
      cwd: () => ctx.directory,
      root: () => ctx.worktree,
      /** The newest messages (4096 at most), oldest first. */
      messages: (options?: { limit?: number }) =>
        call("session.messages", { limit: options?.limit }, (e) =>
          host.inInstance(async () => {
            const limit = Math.min(Math.max(1, e.limit ?? 4096), 4096)
            const found = await readMessages(need("session.messages"), limit)
            return found.map((item) => ({
              id: item.info.id as string,
              role: item.info.role as string,
              agent: (item.info as { agent?: string }).agent,
              text: (item.parts as any[])
                .filter((part) => part.type === "text" && !part.synthetic)
                .map((part) => part.text as string)
                .join("\n"),
              tools: (item.parts as any[]).filter((part) => part.type === "tool").map((part) => part.tool as string),
            }))
          }),
        ),
      model: () =>
        call("session.model", {}, (_e) =>
          host.inInstance(async () => {
            const { SessionRepo } = await import("@/session/repo")
            const last = Effect.runSync(SessionRepo.get(need("session.model")))?.lastModel
            return last ? `${last.providerID}/${last.modelID}` : undefined
          }),
        ),
      turns: () =>
        call("session.turns", {}, (_e) =>
          host.inInstance(
            async () =>
              (await readMessages(need("session.turns"), 4096)).filter((item) => item.info.role === "user").length,
          ),
        ),
      repo: () =>
        call("session.repo", {}, async () => ({ root: ctx.worktree, vcs: ctx.project.vcs, projectID: ctx.project.id })),
      version: () =>
        call("session.version", {}, async () => (await import("@/installation")).Installation.VERSION as string),
      usage: () =>
        call("session.usage", {}, (_e) =>
          host.inInstance(async () => {
            const id = need("session.usage")
            const total = { cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }
            let startedAt: number | undefined
            for (const item of await readMessages(id, 4096)) {
              startedAt ??= item.info.time?.created
              if (item.info.role !== "assistant") continue
              total.cost += item.info.cost ?? 0
              total.tokens.input += item.info.tokens?.input ?? 0
              total.tokens.output += item.info.tokens?.output ?? 0
              total.tokens.reasoning += item.info.tokens?.reasoning ?? 0
              total.tokens.cacheRead += item.info.tokens?.cache?.read ?? 0
              total.tokens.cacheWrite += item.info.tokens?.cache?.write ?? 0
            }
            return { startedAt, ...total }
          }),
        ),
      surfaces: unsupported("session.surfaces"),
      compact: unsupported("session.compact"),
      send: unsupported("session.send"),
      append: unsupported("session.append"),
      authorize: unsupported("session.authorize"),
    }

    // ------------------------------------------------------------ prompt, turn
    const sessionPrompt = async <A>(use: (prompt: any) => Promise<A>) => {
      const { SessionPrompt } = await import("@/session/prompt")
      const { runPromiseWithLayer, locallyInstance } = await import("@/effect")
      return runPromiseWithLayer(
        SessionPrompt.defaultLayer,
        locallyInstance(
          ctx,
          Effect.gen(function* () {
            const service = yield* SessionPrompt.Service
            return yield* Effect.tryPromise(() => use(service))
          }),
        ),
      )
    }

    const promptApi = {
      /**
       * Start a turn from a hook or a timer. Claude reads the text after a sentence that names this mod as
       * the sender; `asUser: true` sends it as the user's own words. It queues behind a turn already running
       * and returns at once: a hook waiting for the turn it runs inside would wait forever.
       */
      submit: (input: { text: string; asUser?: boolean }) =>
        call("prompt.submit", { text: input.text, asUser: input.asUser === true }, async (e) => {
          const id = need("prompt.submit")
          const text = e.asUser ? String(e.text) : `[Message from the mod "${mod.name}"]\n${String(e.text)}`
          void sessionPrompt((service) =>
            Effect.runPromise(service.prompt({ sessionID: id, parts: [{ type: "text", text }], delivery: "queue" })),
          ).catch((error) => log.warn("$.prompt.submit failed", { mod: mod.name, error: String(error) }))
        }),
      read: unsupported("prompt.read"),
      fill: unsupported("prompt.fill"),
      suggest: unsupported("prompt.suggest"),
      compose: unsupported("prompt.compose"),
    }

    const turn = {
      /** Stop the running turn of this session. */
      abort: () =>
        call("turn.abort", {}, async () => {
          const id = need("turn.abort")
          await sessionPrompt((service) => Effect.runPromise(service.cancel(id)))
        }),
    }

    // ------------------------------------------------------------------- model
    const language = async (choice?: string) => {
      const { Provider } = await import("@/provider/provider")
      const { runPromiseWithLayer, locallyInstance } = await import("@/effect")
      return runPromiseWithLayer(
        Provider.defaultLayer,
        locallyInstance(
          ctx,
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            const ref = choice ? Provider.parseModel(choice) : yield* provider.defaultModel()
            const model = yield* provider.getModel(ref.providerID, ref.modelID)
            return yield* provider.getLanguage(model)
          }),
        ),
      )
    }

    const complete = async (e: {
      prompt: string
      system?: string
      maxTokens?: number
      model?: string
      temperature?: number
    }) => {
      const { generateText } = await import("ai")
      const result = await generateText({
        model: await language(e.model),
        system: e.system,
        prompt: String(e.prompt),
        temperature: e.temperature ?? 0,
        maxOutputTokens: Math.min(Math.max(1, e.maxTokens ?? 1024), 64_000),
        abortSignal: ModChain.current()?.signal,
      })
      return {
        text: result.text,
        usage: { inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens },
      }
    }

    const modelApi = {
      /** One completion on the user's own model and plan: `{ prompt, system?, maxTokens? (1024, 64000 at most), model? }`. */
      complete: (input: {
        prompt: string
        system?: string
        maxTokens?: number
        model?: string
        temperature?: number
      }) => call("model.complete", { ...input }, (e) => host.inInstance(() => complete(e as any))),
      /** Pick one of `labels` for `text`. Resolves to the label, or `undefined` when none fits. */
      classify: (text: string, labels: string[], options?: { model?: string }) =>
        call("model.classify", { text, labels, ...options }, (e) =>
          host.inInstance(async () => {
            const result = await complete({
              prompt: `Classify the text into exactly one of these labels: ${(e.labels as string[]).join(", ")}.\nAnswer with the label only, or NONE if none fits.\n\nText:\n${e.text}`,
              maxTokens: 32,
              model: e.model,
            })
            const answer = result.text.trim()
            return (e.labels as string[]).find((label) => label.toLowerCase() === answer.toLowerCase())
          }),
        ),
      fork: unsupported("model.fork"),
    }

    // ---------------------------------------------------------------- settings
    const SECRET = /key|token|secret|password|authorization|credential/i
    const redact = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(redact)
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value).map(([key, inner]) => [
            key,
            SECRET.test(key) && typeof inner === "string" ? "[redacted]" : redact(inner),
          ]),
        )
      }
      return value
    }
    const settings = {
      /** The resolved nikcli config. Values under keys that name a secret (key, token, password, ...) are redacted. */
      read: () =>
        call("settings.read", {}, async () => {
          const { Config } = await import("@/config/config")
          const { runPromiseWithLayer, locallyInstance } = await import("@/effect")
          const config = await runPromiseWithLayer(
            Config.defaultLayer,
            locallyInstance(
              ctx,
              Effect.gen(function* () {
                return yield* (yield* Config.Service).get()
              }),
            ),
          )
          return redact(config)
        }),
    }

    // --------------------------------------------------------------- mcp, agent
    const mcp = {
      /** Call a tool of a connected MCP server. It asks permission like the model's own call does. */
      call: (server: string, name: string, args?: Record<string, unknown>) =>
        call("mcp.call", { server, name, args }, async (e) => {
          const id = need("mcp.call")
          const { MCP } = await import("@/mcp")
          const { PermissionNext } = await import("@/permission/next")
          const { runPromiseWithLayer, locallyInstance } = await import("@/effect")
          const permission = `${String(e.server).replace(/[^a-zA-Z0-9_-]/g, "_")}_${String(e.name).replace(/[^a-zA-Z0-9_-]/g, "_")}`
          await runPromiseWithLayer(
            PermissionNext.defaultLayer,
            locallyInstance(
              ctx,
              Effect.gen(function* () {
                const service = yield* PermissionNext.Service
                return yield* service.ask({
                  sessionID: id,
                  permission,
                  patterns: ["*"],
                  always: ["*"],
                  metadata: {},
                  ruleset: [],
                })
              }),
            ),
          )
          return runPromiseWithLayer(
            MCP.defaultLayer,
            locallyInstance(
              ctx,
              Effect.gen(function* () {
                const clients = yield* (yield* MCP.Service).clients()
                const client = clients[e.server as string]
                if (!client) throw new Error(`no connected MCP server named ${e.server}`)
                return yield* Effect.tryPromise(() =>
                  client.callTool({ name: e.name as string, arguments: (e.args ?? {}) as Record<string, unknown> }),
                )
              }),
            ),
          )
        }),
      connect: unsupported("mcp.connect"),
    }

    const agentApi = {
      /** The subagent types, by name. */
      list: () =>
        call("agent.list", {}, async () => {
          const { Agent } = await import("@/agent/agent")
          const { runPromiseWithLayer, locallyInstance } = await import("@/effect")
          const agents = await runPromiseWithLayer(
            Agent.defaultLayer,
            locallyInstance(
              ctx,
              Effect.gen(function* () {
                return yield* (yield* Agent.Service).list()
              }),
            ),
          )
          return agents.map((agent) => ({ name: agent.name, description: agent.description, mode: agent.mode }))
        }),
      register: unsupported("agent.register"),
      spawn: unsupported("agent.spawn"),
    }

    // ---------------------------------------------------------------- telemetry
    // Only nikcli and its built-in mods ever send a record: for a mod you install these do nothing.
    const telemetry = { log: (_record?: unknown) => undefined, mark: (_feature?: string) => undefined }

    return Object.freeze({
      plugin: Object.freeze({ name: mod.name, root: host.root }),
      ui,
      command,
      tool: toolApi,
      agent: agentApi,
      model: modelApi,
      prompt: promptApi,
      turn,
      session,
      config: { list: unsupported("config.list"), set: unsupported("config.set") },
      settings,
      env,
      fs: filesystem,
      store,
      state,
      clock,
      http,
      process: processApi,
      mcp,
      audio: { play: unsupported("audio.play"), speak: unsupported("audio.speak") },
      telemetry,
    })
  }

  export type Api = ReturnType<typeof make>
}
