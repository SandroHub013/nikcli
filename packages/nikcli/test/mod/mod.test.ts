import { afterAll, describe, expect, it } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import type { Effect as EffectNs } from "effect"
import type { Mod as ModNs } from "@/mod"
import type { PermissionNext as PermNs } from "@/permission/next"
import type { Plugin as PluginNs } from "@/plugin"
import { preserveTestEnv } from "../helpers/env"

// A private home and managed directory before any nikcli module is imported:
// the path singletons read them once.
const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-mod-home-"))
const managedDir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-mod-managed-"))
process.env.NIKCLI_TEST_HOME = testHome
process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1"
process.env.NIKCLI_MANAGED_CONFIG_DIR = managedDir
preserveTestEnv([
  "NIKCLI_TEST_HOME",
  "NIKCLI_DISABLE_PROJECT_CONFIG",
  "NIKCLI_MANAGED_CONFIG_DIR",
  "NIKCLI_DISABLE_MODS",
])

const { Effect } = await import("effect")
const { Plugin } = await import("@/plugin")
const { Mod } = await import("@/mod")
const { PermissionNext } = await import("@/permission/next")
const { PluginTool } = await import("@/tool/plugin")
const commandModule = await import("@/command")
const httpModule = await import("@/server/httpapi/mod")
const { Bus } = await import("@/bus")
// `session/prompt` first: entering through `prompt-commands` is a pre-existing import cycle.
await import("@/session/prompt")
const { PromptCommands } = await import("@/session/prompt-commands")
const { Instance } = await import("@/project/instance")
const { Global } = await import("@nikcli-ai/util/global")
const { runPromiseWithLayer, withCurrentInstance } = await import("@/effect")
const { makeToolContext, withProjectDirectory } = await import("../helpers/tool-context")

const projectDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-mod-project-")))

afterAll(async () => {
  await Instance.disposeAll().catch(() => undefined)
  for (const dir of [projectDir, testHome, managedDir])
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
})

type Probe = { disposed: string[]; calls: string[] }
const probe: Probe = { disposed: [], calls: [] }
;(globalThis as { __modProbe?: Probe }).__modProbe = probe

const SESSION = "ses_modtest0000000000000001"

function plugin<A>(use: (plugin: PluginNs.Interface) => EffectNs.Effect<A, unknown>) {
  return runPromiseWithLayer(
    Plugin.defaultLayer,
    withCurrentInstance(
      Effect.gen(function* () {
        return yield* use(yield* Plugin.Service)
      }),
    ),
  )
}

const status = () => plugin((p) => p.status())
const reload = () => plugin((p) => p.reload())

function mods<A, E>(use: (mod: ModNs.Interface) => EffectNs.Effect<A, E>) {
  return runPromiseWithLayer(
    Mod.defaultLayer,
    withCurrentInstance(
      Effect.gen(function* () {
        return yield* use(yield* Mod.Service)
      }),
    ),
  )
}

async function install(name: string, source: string) {
  const def = await PluginTool.init()
  const { ctx } = makeToolContext()
  return def.executeAsync({ action: "create", name, source }, ctx)
}

async function update(name: string, source: string) {
  const def = await PluginTool.init()
  const { ctx } = makeToolContext()
  return def.executeAsync({ action: "update", name, source }, ctx)
}

const call = (
  args: Record<string, unknown>,
  run = async (a: Record<string, unknown>) => ({ title: "ran", output: JSON.stringify(a), metadata: {} }),
) =>
  Mod.toolCall(
    { tool: "bash", sessionID: SESSION, agent: "build", messageID: "msg_1", callID: "call_1", args },
    run,
    (text) => ({ title: "mod", output: text, metadata: {} }),
  )

describe("a plugin that exports register() is a mod", () => {
  it("loads through the plugin tool, and shows its tier and hooks in the plugin status", async () => {
    await withProjectDirectory(projectDir, async () => {
      const result = await install(
        "force-push-guard",
        `export function register(on) {
  on("tool.call", { tool: "bash" }, async ($, e, next) => {
    if (/git push .*--force/.test(e.command)) return { deny: "Force pushes are not allowed in this repository." }
    return next(e)
  })
}`,
      )
      expect(result.metadata.loaded).toBe(true)
      const found = (await status()).find((entry) => entry.name === "force-push-guard")
      expect(found?.error).toBeUndefined()
      expect(found?.mod).toMatchObject({ tier: "user", events: ["tool.call"] })
      expect(found?.hooks).toEqual(["tool.call"])
    })
  })

  it("denies a call without running the tool, and lets other calls through unchanged", async () => {
    await withProjectDirectory(projectDir, async () => {
      let ran = 0
      const run = async (a: Record<string, unknown>) => (
        ran++,
        { title: "ran", output: String(a.command), metadata: {} }
      )
      const denied = await call({ command: "git push --force origin main" }, run)
      expect(denied.output).toBe("Force pushes are not allowed in this repository.")
      expect(ran).toBe(0)

      const allowed = await call({ command: "git status" }, run)
      expect(allowed.output).toBe("git status")
      expect(ran).toBe(1)
    })
  })

  it("rewrites arguments, answers instead of running, and retries a failed call", async () => {
    await withProjectDirectory(projectDir, async () => {
      await install(
        "rewriter",
        `export function register(on) {
  on("tool.call", { tool: "bash", command: /^rewrite / }, async ($, e, next) => next({ ...e, command: "echo rewritten" }))
  on("tool.call", { tool: "bash", command: /^answer / }, async () => ({ result: "answered by a mod" }))
  on("tool.call", { tool: "bash", command: /^retry / }, async ($, e, next) => {
    const first = await next(e)
    return first.isError ? next(e) : first
  })
}`,
      )
      const seen: string[] = []
      const run = async (a: Record<string, unknown>) => {
        seen.push(String(a.command))
        return { title: "ran", output: String(a.command), metadata: {} }
      }
      expect((await call({ command: "rewrite me" }, run)).output).toBe("echo rewritten")
      expect(seen).toEqual(["echo rewritten"])

      seen.length = 0
      expect((await call({ command: "answer please" }, run)).output).toBe("answered by a mod")
      expect(seen).toEqual([])

      let attempts = 0
      const flaky = async () => {
        if (++attempts === 1) throw new Error("transient")
        return { title: "ran", output: "second try", metadata: {} }
      }
      expect((await call({ command: "retry this" }, flaky)).output).toBe("second try")
      expect(attempts).toBe(2)
    })
  })

  it("rethrows nikcli's own error unchanged when no hook replaced it", async () => {
    await withProjectDirectory(projectDir, async () => {
      class Boom extends Error {}
      const failure = new Boom("tool exploded")
      const thrown = await call({ command: "git status" }, async () => {
        throw failure
      }).catch((error) => error)
      expect(thrown).toBe(failure)
    })
  })

  it("hot reload replaces the mod: the old generation is gone, the new one answers", async () => {
    await withProjectDirectory(projectDir, async () => {
      await update(
        "force-push-guard",
        `export function register(on) {
  on("tool.call", { tool: "bash" }, async () => ({ deny: "Version two." }))
}`,
      )
      expect((await call({ command: "ls" })).output).toBe("Version two.")
      const found = (await status()).filter((entry) => entry.name === "force-push-guard")
      expect(found).toHaveLength(1)
      expect((await mods((m) => m.list())).filter((m) => m.name === "force-push-guard")).toHaveLength(1)
    })
  })

  it("a hook that throws is skipped: the call still runs", async () => {
    await withProjectDirectory(projectDir, async () => {
      // The earlier generation of this guard denies every bash call; take it out of the chain.
      const def = await PluginTool.init()
      await def.executeAsync({ action: "remove", name: "force-push-guard" }, makeToolContext().ctx)
      await install(
        "thrower",
        `export function register(on) {
  on("tool.call", { tool: "bash", command: /^throw / }, async () => { throw new Error("hook bug") })
}`,
      )
      expect((await call({ command: "throw now" })).output).toContain("throw now")
    })
  })

  it("registers a tool and a command with the mods API, and stops them on unload", async () => {
    await withProjectDirectory(projectDir, async () => {
      await install(
        "api-mod",
        `export function register(on) {
  on("session.start", async ($, e, next) => {
    $.command.register({ name: "hello-mod", description: "say hello", run: async (args) => "hello " + args })
    return next(e)
  })
  on("tool.call", { tool: "echo_mod" }, async ($, e, next) => next(e))
}`,
      )
      const list = await mods((m) => m.commands())
      expect(list).toContainEqual({ name: "hello-mod", description: "say hello" })
      const command = await mods((m) => m.command("hello-mod"))
      expect(await command?.run("world")).toBe("hello world")

      const def = await PluginTool.init()
      const { ctx } = makeToolContext()
      await def.executeAsync({ action: "remove", name: "api-mod" }, ctx)
      expect(await mods((m) => m.command("hello-mod"))).toBeUndefined()
    })
  })

  it("refuses a mod whose use of $ cannot be reviewed", async () => {
    await withProjectDirectory(projectDir, async () => {
      const result = await install(
        "sneaky",
        `export function register(on) {
  on("tool.call", async ($, e, next) => {
    const { process } = $
    return next(e)
  })
}`,
      )
      expect(result.metadata.loaded).toBe(false)
      expect(result.output).toContain("cannot be reviewed")
      expect((await status()).find((entry) => entry.name === "sneaky")?.error).toContain("$ destructured")
    })
  })
})

describe("tool.check and the sec-default guard", () => {
  const permission = <A, E>(effect: EffectNs.Effect<A, E, PermNs.Service>) =>
    runPromiseWithLayer(PermissionNext.defaultLayer, withCurrentInstance(effect))

  const ask = (ruleset: PermNs.Ruleset, permissionName = "bash") =>
    permission(
      Effect.gen(function* () {
        const service = yield* PermissionNext.Service
        const exit = yield* Effect.exit(
          Effect.timeoutOrElse(
            service.ask({
              sessionID: SESSION,
              permission: permissionName,
              patterns: ["rm -rf build"],
              metadata: {},
              always: [],
              ruleset,
            }),
            { duration: 150, orElse: () => Effect.succeed("pending" as const) },
          ),
        )
        return exit
      }),
    )

  it("an approving mod answers before the user is asked; with no mod the same call waits", async () => {
    await withProjectDirectory(projectDir, async () => {
      const asking: PermNs.Ruleset = [{ permission: "bash", pattern: "*", action: "ask" }]
      expect(await ask(asking)).toMatchObject({ _tag: "Success", value: "pending" })

      await install(
        "approver",
        `export function register(on) {
  on("tool.check", { tool: "bash" }, async ($, e, next) => {
    const decided = await next(e)
    return /rm -rf build/.test(e.patterns[0]) ? { decision: "allow" } : decided
  })
}`,
      )
      const exit = await ask(asking)
      expect(exit._tag).toBe("Success")
      expect((exit as { value: unknown }).value).toBeUndefined()
    })
  })

  it("a refusing mod blocks an allowed call with its reason", async () => {
    await withProjectDirectory(projectDir, async () => {
      await install(
        "refuser",
        `export function register(on) {
  on("tool.check", { tool: "edit" }, async () => ({ decision: "deny", reason: "edits are frozen this week" }))
}`,
      )
      const exit = await ask([{ permission: "edit", pattern: "*", action: "allow" }], "edit")
      expect(exit._tag).toBe("Failure")
      expect(String((exit as { cause: unknown }).cause)).toContain("edits are frozen this week")
    })
  })

  it("a deny rule stays a deny when a user's mod approves it", async () => {
    await withProjectDirectory(projectDir, async () => {
      await install(
        "overrider",
        `export function register(on) {
  on("tool.check", { tool: "write" }, async () => ({ decision: "allow" }))
}`,
      )
      const exit = await ask([{ permission: "write", pattern: "*", action: "deny" }], "write")
      expect(exit._tag).toBe("Failure")
      expect(String((exit as { cause: unknown }).cause)).toContain("PermissionDeniedError")
    })
  })
})

describe("prompt.submit and tool.describe", () => {
  it("rewrites a prompt, adds context only the model reads, and drops one on request", async () => {
    await withProjectDirectory(projectDir, async () => {
      await install(
        "prompt-mod",
        `export function register(on) {
  on("prompt.submit", async ($, e, next) => {
    if (/^drop:/.test(e.text)) return { drop: "not today" }
    const trimmed = { ...e, text: e.text.trim() }
    return / PR$/.test(e.text) ? next({ ...trimmed, context: [...e.context, "Current branch: main"] }) : next(trimmed)
  })
}`,
      )
      expect(await Mod.promptSubmit({ sessionID: SESSION, agent: "build", text: "  hello  " })).toEqual({
        text: "hello",
        context: [],
      })
      expect(await Mod.promptSubmit({ sessionID: SESSION, agent: "build", text: "open a PR" })).toEqual({
        text: "open a PR",
        context: ["Current branch: main"],
      })
      await expect(Mod.promptSubmit({ sessionID: SESSION, agent: "build", text: "drop: x" })).rejects.toThrow(
        "not today",
      )
    })
  })

  it("rewrites what the model reads about a tool", async () => {
    await withProjectDirectory(projectDir, async () => {
      expect(await Mod.handles("tool.describe")).toBe(false)
      await install(
        "describer",
        `export function register(on) {
  on("tool.describe", { tool: "bash" }, async ($, e, next) => ({ description: e.description + " Never run destructive commands." }))
}`,
      )
      expect(await Mod.handles("tool.describe")).toBe(true)
      expect(await Mod.describe("bash", "Run a shell command.")).toBe(
        "Run a shell command. Never run destructive commands.",
      )
      expect(await Mod.describe("read", "Read a file.")).toBe("Read a file.")
    })
  })

  it("with no mod on an event the call sites do exactly what they did before", async () => {
    await withProjectDirectory(projectDir, async () => {
      expect(await Mod.handles("session.compact")).toBe(false)
      expect(
        (await call({ command: "echo" }, async () => ({ title: "t", output: "plain", metadata: {} }))).output,
      ).toBe("plain")
    })
  })
})

describe("mod commands and command.run", () => {
  const { Command } = commandModule

  /** The deps `PromptCommands.command` reads on the path that runs no model turn, recording what it persists. */
  function fakeDeps() {
    const messages: any[] = []
    const parts: any[] = []
    const deps = {
      commandGet: (name: string) =>
        runPromiseWithLayer(
          Command.defaultLayer,
          withCurrentInstance(
            Effect.gen(function* () {
              return yield* (yield* Command.Service).get(name)
            }),
          ),
        ),
      defaultAgent: async () => "build",
      lastModel: async () => ({ providerID: "anthropic", modelID: "claude-opus-5" }),
      currentContext: () => ({ directory: projectDir, worktree: projectDir }) as any,
      sessionUpdateMessage: async (message: any) => void messages.push(message),
      sessionUpdatePart: async (part: any) => void parts.push(part),
    }
    return { deps: deps as unknown as Parameters<typeof PromptCommands.command>[0], messages, parts }
  }

  const slash = (name: string, args = "") =>
    PromptCommands.command(fakeDeps().deps, { sessionID: SESSION, command: name, arguments: args } as any)

  it("lists a mod's command beside the configured ones, and runs it with no model turn", async () => {
    await withProjectDirectory(projectDir, async () => {
      await install(
        "slash-mod",
        `export function register(on) {
  on("session.start", async ($, e, next) => {
    $.command.register({ name: "greet", description: "say hello", run: async (args) => "hello " + args })
    return next(e)
  })
}`,
      )
      const listed = await runPromiseWithLayer(
        Command.defaultLayer,
        withCurrentInstance(
          Effect.gen(function* () {
            return yield* (yield* Command.Service).list()
          }),
        ),
      )
      expect(listed.find((command) => command.name === "greet")).toMatchObject({
        mod: true,
        description: "say hello",
        template: "",
      })

      const { deps, messages, parts } = fakeDeps()
      const result = await PromptCommands.command(deps, {
        sessionID: SESSION,
        command: "greet",
        arguments: "world",
      } as any)
      expect(result.parts.map((part: any) => part.text)).toEqual(["hello world"])
      expect(result.info.role).toBe("assistant")
      expect(parts.map((part) => part.text)).toEqual(["/greet world", "hello world"])
      expect(messages.map((message) => message.role)).toEqual(["user", "assistant"])
    })
  })

  it("a command.run mod rewrites the arguments of a mod command, and can answer without running it", async () => {
    await withProjectDirectory(projectDir, async () => {
      await install(
        "command-hook",
        `export function register(on) {
  on("command.run", { name: "greet", kind: "mod" }, async ($, e, next) => {
    if (e.arguments === "secret") return { text: "answered by a mod" }
    return next({ ...e, arguments: e.arguments.toUpperCase() })
  })
}`,
      )
      expect((await slash("greet", "world")).parts.map((part: any) => part.text)).toEqual(["hello WORLD"])
      expect((await slash("greet", "secret")).parts.map((part: any) => part.text)).toEqual(["answered by a mod"])
    })
  })

  it("an unknown command still fails exactly as before", async () => {
    await withProjectDirectory(projectDir, async () => {
      await expect(slash("no-such-command")).rejects.toThrow('Command "no-such-command" not found')
    })
  })
})

describe("turns, prompt sections, subagents and the mods API", () => {
  it("turn.step sends a request to another model; turn.start and turn.complete see the edges", async () => {
    await withProjectDirectory(projectDir, async () => {
      probe.calls.length = 0
      await install(
        "turn-mod",
        `export function register(on) {
  on("turn.start", async ($, e, next) => (globalThis.__modProbe.calls.push("start:" + e.turnId), next(e)))
  on("turn.step", async ($, e, next) => next({ ...e, model: "openai/gpt-fast" }))
  on("turn.complete", async ($, e, next) => (globalThis.__modProbe.calls.push("complete:" + e.answer + ":" + e.isAborted), next(e)))
}`,
      )
      await Mod.turnStart({ sessionID: SESSION, turnId: "turn_1" })
      const step = await Mod.turnStep({
        sessionID: SESSION,
        turnId: "turn_1",
        step: 1,
        agent: "build",
        model: "anthropic/claude-opus-5",
      })
      expect(step.model).toBe("openai/gpt-fast")
      await Mod.turnComplete({ sessionID: SESSION, turnId: "turn_1", answer: "done", durationMs: 5, isAborted: false })
      expect(probe.calls).toEqual(["start:turn_1", "complete:done:false"])
    })
  })

  it("prompt.section rewrites or omits a section; prompt.compose reorders", async () => {
    await withProjectDirectory(projectDir, async () => {
      const sections = [
        { id: "provider", text: "BASE" },
        { id: "system", text: "SYS" },
        { id: "user", text: "USER" },
      ]
      expect(await Mod.promptSections(sections)).toEqual(sections)

      await install(
        "prompt-sections",
        `export function register(on) {
  on("prompt.section", { name: "user" }, async ($, e, next) => ({ text: e.text + "!" }))
  on("prompt.section", { name: "system" }, async () => ({ text: null }))
  on("prompt.compose", async ($, e, next) => ({ sections: [...e.sections].reverse() }))
}`,
      )
      expect(await Mod.promptSections(sections)).toEqual([
        { id: "user", text: "USER!" },
        { id: "provider", text: "BASE" },
      ])
    })
  })

  it("agent.offer withholds a subagent type; agent.spawn refuses one or picks its model", async () => {
    await withProjectDirectory(projectDir, async () => {
      await install(
        "agent-mod",
        `export function register(on) {
  on("agent.offer", { agent: "secret" }, async () => ({ isOffered: false }))
  on("agent.spawn", { agent: "reviewer" }, async ($, e, next) => next({ ...e, model: "anthropic/claude-haiku" }))
  on("agent.spawn", { agent: "blocked" }, async () => ({ deny: "That agent is off this week." }))
}`,
      )
      expect(await Mod.agentOffered({ name: "secret" })).toBe(false)
      expect(await Mod.agentOffered({ name: "explore" })).toBe(true)
      expect(await Mod.agentSpawn({ sessionID: SESSION, agent: "reviewer", description: "d", prompt: "p" })).toEqual({
        deny: undefined,
        model: "anthropic/claude-haiku",
      })
      expect((await Mod.agentSpawn({ sessionID: SESSION, agent: "blocked", description: "d", prompt: "p" })).deny).toBe(
        "That agent is off this week.",
      )
    })
  })

  it("a hook can use fs, process, env, store, clock and settings, and see which session it is in", async () => {
    await withProjectDirectory(projectDir, async () => {
      await Bun.write(path.join(projectDir, "note.txt"), "from disk")
      await install(
        "api-tour",
        `export function register(on) {
  on("tool.call", { tool: "tour" }, async ($, e, next) => {
    await $.store.set("seen", (await $.store.get("seen") ?? 0) + 1)
    $.env.set("MOD_TOUR", "yes")
    const ran = await $.process.run(["echo", "hi"])
    const settings = await $.settings.read()
    $.telemetry.mark("x")
    return { result: JSON.stringify({
      file: await $.fs.read("note.txt"),
      exists: await $.fs.exists("nope.txt"),
      echo: ran.stdout.trim(),
      env: await $.env.get("MOD_TOUR"),
      seen: await $.store.get("seen"),
      session: $.session.id(),
      cwd: $.session.cwd(),
      version: typeof (await $.session.version()),
      slept: await $.clock.sleep(1) === undefined,
      settings: typeof settings,
    }) }
  })
}`,
      )
      const run = async () =>
        JSON.parse(
          (
            await Mod.toolCall(
              { tool: "tour", sessionID: SESSION, agent: "build", messageID: "m", callID: "c", args: {} },
              async () => ({ title: "x", output: "should not run", metadata: {} }),
              (text) => ({ title: "mod", output: text, metadata: {} }),
            )
          ).output,
        )
      const first = await run()
      expect(first).toMatchObject({
        file: "from disk",
        exists: false,
        echo: "hi",
        env: "yes",
        session: SESSION,
        cwd: projectDir,
        version: "string",
        slept: true,
        settings: "object",
      })
      expect((await run()).seen).toBe(first.seen + 1)
    })
  })

  it("an API call is an event: a policy mod denies what another mod asks for", async () => {
    await withProjectDirectory(projectDir, async () => {
      await install(
        "audit-first",
        `export function register(on) {
  on("process.run", async ($, e, next) => (e.command[0] === "rm" ? { deny: "rm is not allowed" } : next(e)))
}`,
      )
      await install(
        "wants-rm",
        `export function register(on) {
  on("tool.call", { tool: "wants_rm" }, async ($, e, next) => {
    try { await $.process.run(["rm", "-rf", "x"]) } catch (error) { return { result: error.message } }
    return { result: "ran" }
  })
}`,
      )
      const out = await Mod.toolCall(
        { tool: "wants_rm", sessionID: SESSION, agent: "build", messageID: "m", callID: "c", args: {} },
        async () => ({ title: "x", output: "no", metadata: {} }),
        (text) => ({ title: "mod", output: text, metadata: {} }),
      )
      expect(out.output).toContain("rm is not allowed")
    })
  })

  it("a mod's tool, timers and processes stop when it unloads", async () => {
    await withProjectDirectory(projectDir, async () => {
      probe.calls.length = 0
      await install(
        "ticker",
        `export function register(on) {
  on("session.start", async ($, e, next) => {
    $.clock.every(20, () => globalThis.__modProbe.calls.push("tick"))
    $.tool.register({ name: "ticker_tool", description: "d", args: {}, execute: async () => "ok" })
    return next(e)
  })
}`,
      )
      await new Promise((resolve) => setTimeout(resolve, 80))
      expect(probe.calls.filter((call) => call === "tick").length).toBeGreaterThan(0)
      expect(Object.keys(await mods((m) => m.tools()))).toContain("ticker_tool")

      const def = await PluginTool.init()
      await def.executeAsync({ action: "remove", name: "ticker" }, makeToolContext().ctx)
      probe.calls.length = 0
      await new Promise((resolve) => setTimeout(resolve, 80))
      expect(probe.calls).toEqual([])
      expect(Object.keys(await mods((m) => m.tools()))).not.toContain("ticker_tool")
    })
  })
})

describe("what a mod draws", () => {
  const { ModHttpApi } = httpModule

  const render = (input: { component: string; requestId?: string; props?: Record<string, unknown> }): Promise<any> =>
    runPromiseWithLayer(
      Mod.defaultLayer,
      withCurrentInstance(
        ModHttpApi.handlers.render({
          payload: {
            component: input.component,
            requestId: input.requestId,
            sessionID: SESSION,
            props: JSON.stringify(input.props ?? {}),
            columns: 100,
            rows: 30,
          },
        }),
      ),
    )

  const press = (key: string) =>
    runPromiseWithLayer(
      Mod.defaultLayer,
      withCurrentInstance(
        ModHttpApi.handlers.event({
          payload: { kind: "press", key, component: "AbovePrompt", requestId: "band", sessionID: SESSION },
        }),
      ),
    )

  it("with no mod on ui.render a site is the default: nothing is asked and nothing is drawn", async () => {
    await withProjectDirectory(projectDir, async () => {
      expect(await render({ component: "AbovePrompt", requestId: "band" })).toEqual({ kind: "default" })
    })
  })

  it("a mod draws a tree for a site; a press comes back to it and it can invalidate", async () => {
    await withProjectDirectory(projectDir, async () => {
      probe.calls.length = 0
      await install(
        "band-mod",
        `export function register(on) {
  let pressed = 0
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    return { tree: Box({ gap: 1 }, Text({ color: "success" }, "pressed " + pressed + " " + (e.props.isWorking ? "busy" : "idle")), Button({ key: "go", label: "Go" })) }
  })
  on("ui.press", { key: "go" }, async ($, e, next) => {
    pressed++
    globalThis.__modProbe.calls.push("press:" + e.component + ":" + e.requestId)
    $.ui.invalidate("AbovePrompt")
    return { handled: true }
  })
}`,
      )
      const seen: any[] = []
      const unsubscribe = Bus.subscribe(Mod.UiEvent.Invalidate, (event: any) => seen.push(event.properties))

      const first = await render({ component: "AbovePrompt", requestId: "band", props: { isWorking: true } })
      expect(first.kind).toBe("tree")
      expect(JSON.parse(first.tree!)).toMatchObject({
        type: "Box",
        children: [
          { type: "Text", props: { color: "success" }, children: ["pressed 0 busy"] },
          { type: "Button", key: "go", props: { label: "Go" } },
        ],
      })

      expect(await press("go")).toEqual({ handled: true })
      expect(probe.calls).toEqual(["press:AbovePrompt:band"])
      expect(
        JSON.parse((await render({ component: "AbovePrompt", requestId: "band" })).tree!).children[0].children,
      ).toEqual(["pressed 1 idle"])

      // An unknown key is not handled; a hook for another site does not see this one.
      expect(await press("nope")).toEqual({ handled: false })
      expect(await render({ component: "Pane", requestId: "p" })).toMatchObject({ kind: "default" })

      await new Promise((resolve) => setTimeout(resolve, 200))
      unsubscribe()
      expect(seen).toEqual([{ component: "AbovePrompt" }])
    })
  })

  it("a tree a client could not draw is dropped, and a mod can rewrite a site's props or draw nothing", async () => {
    await withProjectDirectory(projectDir, async () => {
      await install(
        "bad-tree",
        `export function register(on) {
  on("ui.render", { component: "Pane", requestId: "bad" }, async () => ({ tree: { type: "Script", props: {} } }))
  on("ui.render", { component: "Pane", requestId: "props" }, async ($, e, next) => next({ ...e, props: { ...e.props, title: "Renamed" } }))
  on("ui.render", { component: "Pane", requestId: "hidden" }, async () => ({ tree: null }))
}`,
      )
      expect(await render({ component: "Pane", requestId: "bad" })).toMatchObject({ kind: "default" })
      const rewritten = await render({
        component: "Pane",
        requestId: "props",
        props: { title: "Old", placement: "dock" },
      })
      expect(rewritten.kind).toBe("default")
      expect(JSON.parse(rewritten.props!)).toEqual({ title: "Renamed", placement: "dock" })
      expect(await render({ component: "Pane", requestId: "hidden" })).toEqual({ kind: "tree" })
    })
  })

  it("opens and closes panes with $.ui.open, tells clients, and closes them when the mod unloads", async () => {
    await withProjectDirectory(projectDir, async () => {
      const changes: number[] = []
      const unsubscribe = Bus.subscribe(Mod.UiEvent.Panes, () => changes.push(Date.now()))
      await install(
        "pane-mod",
        `export function register(on) {
  on("session.start", async ($, e, next) => {
    $.ui.open({ id: "build", title: "Build", placement: "dock" })
    $.ui.open({ id: "log", title: "Log", placement: "inline", rows: 4 })
    $.ui.close("log")
    return next(e)
  })
}`,
      )
      const listed = await runPromiseWithLayer(Mod.defaultLayer, withCurrentInstance(ModHttpApi.handlers.panes()))
      expect(listed).toEqual([{ id: "build", plugin: "pane-mod", title: "Build", placement: "dock" }])
      expect(changes.length).toBeGreaterThanOrEqual(3)

      const def = await PluginTool.init()
      await def.executeAsync({ action: "remove", name: "pane-mod" }, makeToolContext().ctx)
      expect(await runPromiseWithLayer(Mod.defaultLayer, withCurrentInstance(ModHttpApi.handlers.panes()))).toEqual([])
      unsubscribe()
    })
  })

  it("lists loaded mods with their tier and hooks", async () => {
    await withProjectDirectory(projectDir, async () => {
      const list = await runPromiseWithLayer(Mod.defaultLayer, withCurrentInstance(ModHttpApi.handlers.list()))
      const band = list.find((mod) => mod.name === "band-mod")
      expect(band).toMatchObject({ tier: "user", events: ["ui.render", "ui.press"] })
    })
  })
})

describe("skills, compaction, command descriptions, prompt fill", () => {
  it("skill.prompt rewrites a skill's text; session.compact can skip a compaction", async () => {
    await withProjectDirectory(projectDir, async () => {
      expect(await Mod.skillPrompt("review", "BODY")).toBe("BODY")
      expect(await Mod.sessionCompact({ sessionID: SESSION, auto: true })).toEqual({})
      await install(
        "skill-compact",
        `export function register(on) {
  on("skill.prompt", { name: "review" }, async ($, e, next) => ({ text: e.text + "\\nBe terse." }))
  on("session.compact", async ($, e, next) => (e.auto ? { skip: "never auto-compact here" } : next(e)))
}`,
      )
      expect(await Mod.skillPrompt("review", "BODY")).toBe("BODY\nBe terse.")
      expect(await Mod.skillPrompt("other", "BODY")).toBe("BODY")
      expect(await Mod.sessionCompact({ sessionID: SESSION, auto: true })).toEqual({ skip: "never auto-compact here" })
      expect(await Mod.sessionCompact({ sessionID: SESSION, auto: false })).toEqual({})
    })
  })

  it("command.describe renames or hides a command in the list", async () => {
    await withProjectDirectory(projectDir, async () => {
      await install(
        "describe-cmds",
        `export function register(on) {
  on("session.start", async ($, e, next) => {
    $.command.register({ name: "keep-me", description: "old", run: async () => "x" })
    $.command.register({ name: "hide-me", description: "secret", run: async () => "x" })
    return next(e)
  })
  on("command.describe", { name: "keep-me" }, async ($, e, next) => next({ ...e, description: "renamed" }))
  on("command.describe", { name: "hide-me" }, async ($, e, next) => next({ ...e, isHidden: true }))
}`,
      )
      const listed = await runPromiseWithLayer(
        commandModule.Command.defaultLayer,
        withCurrentInstance(
          Effect.gen(function* () {
            return yield* (yield* commandModule.Command.Service).list()
          }),
        ),
      )
      expect(listed.find((command) => command.name === "keep-me")?.description).toBe("renamed")
      expect(listed.find((command) => command.name === "hide-me")).toBeUndefined()
    })
  })

  it("$.prompt.fill adds a draft to the prompt box", async () => {
    await withProjectDirectory(projectDir, async () => {
      const { TuiEvent } = await import("@/bus/tui-event")
      const seen: string[] = []
      const unsubscribe = Bus.subscribe(TuiEvent.PromptAppend, (event: any) => seen.push(event.properties.text))
      await install(
        "filler",
        `export function register(on) {
  on("tool.call", { tool: "fill_it" }, async ($, e, next) => { await $.prompt.fill("draft from a mod"); return { result: "ok" } })
}`,
      )
      await Mod.toolCall(
        { tool: "fill_it", sessionID: SESSION, agent: "build", messageID: "m", callID: "c", args: {} },
        async () => ({ title: "x", output: "no", metadata: {} }),
        (text) => ({ title: "mod", output: text, metadata: {} }),
      )
      await new Promise((resolve) => setTimeout(resolve, 50))
      unsubscribe()
      expect(seen).toEqual(["draft from a mod"])
    })
  })
})

describe("managed policy", () => {
  const policyProject = async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-mod-policy-project-")))
    return dir
  }
  const setPolicy = (mod: Record<string, unknown>) =>
    Bun.write(path.join(managedDir, "nikcli.json"), JSON.stringify({ mod }))

  it("allowManagedModsOnly refuses a user's mod and keeps the organization's own", async () => {
    await setPolicy({ allowManagedModsOnly: true })
    await Bun.write(
      path.join(managedDir, "plugins", "acme-guard", "index.ts"),
      `export function register(on) {
  on("tool.call", { tool: "bash" }, async () => ({ deny: "Acme policy." }))
}`,
    )
    const dir = await policyProject()
    try {
      await withProjectDirectory(dir, async () => {
        const result = await install(
          "user-mod",
          `export function register(on) { on("tool.call", async ($, e, next) => next(e)) }`,
        )
        expect(result.metadata.loaded).toBe(false)
        expect(result.output).toContain("limited to your organization's")

        const entries = await status()
        expect(entries.find((entry) => entry.name === "acme-guard")?.mod?.tier).toBe("prepend")
        expect((await call({ command: "ls" })).output).toBe("Acme policy.")
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("a managed policy that cannot be read fails closed: no user mod loads", async () => {
    await Bun.write(path.join(managedDir, "nikcli.json"), "{ not json")
    const dir = await policyProject()
    try {
      await withProjectDirectory(dir, async () => {
        const result = await install(
          "another-user-mod",
          `export function register(on) { on("tool.call", async ($, e, next) => next(e)) }`,
        )
        expect(result.metadata.loaded).toBe(false)
        expect(result.output).toContain("could not be read")
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("allowModsToOverrideDenyRules lets a user's mod approve what a deny rule refuses", async () => {
    await setPolicy({ allowModsToOverrideDenyRules: true })
    await fs.rm(path.join(managedDir, "plugins"), { recursive: true, force: true })
    const dir = await policyProject()
    try {
      await withProjectDirectory(dir, async () => {
        await install(
          "deny-overrider",
          `export function register(on) { on("tool.check", { tool: "write" }, async () => ({ decision: "allow" })) }`,
        )
        const exit = await runPromiseWithLayer(
          PermissionNext.defaultLayer,
          withCurrentInstance(
            Effect.gen(function* () {
              const service = yield* PermissionNext.Service
              return yield* Effect.exit(
                service.ask({
                  sessionID: SESSION,
                  permission: "write",
                  patterns: ["x"],
                  metadata: {},
                  always: [],
                  ruleset: [{ permission: "write", pattern: "*", action: "deny" }],
                }),
              )
            }),
          ),
        )
        expect(exit._tag).toBe("Success")
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("disableAllMods turns every mod off", async () => {
    await setPolicy({ disableAllMods: true })
    const dir = await policyProject()
    try {
      await withProjectDirectory(dir, async () => {
        const result = await install(
          "off-mod",
          `export function register(on) { on("tool.call", async ($, e, next) => next(e)) }`,
        )
        expect(result.metadata.loaded).toBe(false)
        expect(result.output).toContain("mods are turned off")
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

void Global
