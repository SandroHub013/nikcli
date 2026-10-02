import fs from "fs/promises"
import path from "path"
import { Effect, Scope } from "effect"
import { tool, type ToolDefinition } from "@nikcli-ai/plugin/tool"
import { Global } from "@nikcli-ai/util/global"
import { Log } from "@nikcli-ai/util/log"
import { Filesystem } from "@nikcli-ai/util/filesystem"
import type { InstanceContext } from "@/effect"
import { ModChain } from "./chain"

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
    "ui.resolve",
    "ui.invalidate",
    "ui.open",
    "ui.close",
    "ui.panes",
    "ui.focus",
    "ui.scroll",
    "ui.status",
    "ui.copy",
    "ui.blit",
    "agent.register",
    "agent.spawn",
    "agent.list",
    "model.complete",
    "model.fork",
    "model.classify",
    "prompt.submit",
    "prompt.read",
    "prompt.fill",
    "prompt.suggest",
    "prompt.compose",
    "turn.abort",
    "session.messages",
    "session.model",
    "session.turns",
    "session.repo",
    "session.surfaces",
    "session.usage",
    "session.version",
    "session.compact",
    "session.send",
    "session.append",
    "session.authorize",
    "config.list",
    "config.set",
    "settings.read",
    "mcp.call",
    "mcp.connect",
    "tool.call",
    "tool.check",
    "audio.play",
    "audio.speak",
    "telemetry.log",
    "telemetry.mark",
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
    publish: (run: () => Promise<unknown>) => Promise<unknown>
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
    const ui = {
      log: (text: string, options?: { to?: "transcript" | "debug" }) =>
        call("ui.log", { text, ...options }, async (e) => {
          log.info("mod log", { mod: mod.name, text: e.text })
          if (e.to === "debug") return
          await host.publish(async () => {
            const { Bus } = await import("@/bus")
            const { Mod } = await import("./index")
            await Bus.publish(Mod.Event.Log, { plugin: mod.name, sessionID: sessionID(), text: String(e.text) })
          })
        }),
      toast: (text: string, options?: { variant?: "info" | "success" | "warning" | "error"; timeoutMs?: number }) =>
        call("ui.toast", { text, ...options }, async (e) => {
          await host.publish(async () => {
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
      resolve: unsupported("ui.resolve"),
      invalidate: unsupported("ui.invalidate"),
      open: unsupported("ui.open"),
      close: unsupported("ui.close"),
      panes: unsupported("ui.panes"),
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
    const session = {
      id: () => sessionID(),
      cwd: () => ctx.directory,
      root: () => ctx.worktree,
      messages: unsupported("session.messages"),
      model: unsupported("session.model"),
      turns: unsupported("session.turns"),
      repo: unsupported("session.repo"),
      surfaces: unsupported("session.surfaces"),
      usage: unsupported("session.usage"),
      version: unsupported("session.version"),
      compact: unsupported("session.compact"),
      send: unsupported("session.send"),
      append: unsupported("session.append"),
      authorize: unsupported("session.authorize"),
    }

    return Object.freeze({
      plugin: Object.freeze({ name: mod.name, root: host.root }),
      ui,
      command,
      tool: toolApi,
      agent: {
        register: unsupported("agent.register"),
        spawn: unsupported("agent.spawn"),
        list: unsupported("agent.list"),
      },
      model: {
        complete: unsupported("model.complete"),
        fork: unsupported("model.fork"),
        classify: unsupported("model.classify"),
      },
      prompt: {
        submit: unsupported("prompt.submit"),
        read: unsupported("prompt.read"),
        fill: unsupported("prompt.fill"),
        suggest: unsupported("prompt.suggest"),
        compose: unsupported("prompt.compose"),
      },
      turn: { abort: unsupported("turn.abort") },
      session,
      config: { list: unsupported("config.list"), set: unsupported("config.set") },
      settings: { read: unsupported("settings.read") },
      env,
      fs: filesystem,
      store,
      state,
      clock,
      http,
      process: processApi,
      mcp: { call: unsupported("mcp.call"), connect: unsupported("mcp.connect") },
      audio: { play: unsupported("audio.play"), speak: unsupported("audio.speak") },
      telemetry: { log: unsupported("telemetry.log"), mark: unsupported("telemetry.mark") },
    })
  }

  export type Api = ReturnType<typeof make>
}
