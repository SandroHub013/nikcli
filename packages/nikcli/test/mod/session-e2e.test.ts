import { afterAll, describe, expect, it } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import type { Effect as EffectNs } from "effect"
import { preserveTestEnv } from "../helpers/env"

// A private home before any nikcli module is imported: the path singletons read it once.
const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-mod-e2e-home-"))
process.env.NIKCLI_TEST_HOME = testHome
process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1"
process.env.NIKCLI_MANAGED_CONFIG_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-mod-e2e-managed-"))
preserveTestEnv(["NIKCLI_TEST_HOME", "NIKCLI_DISABLE_PROJECT_CONFIG", "NIKCLI_MANAGED_CONFIG_DIR"])

const { Instance } = await import("@/project/instance")
const { PluginTool } = await import("@/tool/plugin")
const { makeToolContext } = await import("../helpers/tool-context")

afterAll(async () => {
  await Instance.disposeAll().catch(() => undefined)
  await fs.rm(testHome, { recursive: true, force: true }).catch(() => {})
})

/**
 * A mod against the real session pipeline: `resolveTools` builds the toolset the
 * model is given, and its `execute` runs the real `read` tool through the
 * `tool.call` chain — the same path a model's tool call takes.
 */
describe.serial("mods in the session pipeline", () => {
  const anthropic = { providerID: "anthropic", api: { id: "claude-opus-5" } }
  const callOptions = () => ({ toolCallId: "call_e2e", abortSignal: new AbortController().signal, messages: [] })

  async function withSession(
    fn: (input: {
      directory: string
      resolve: () => Promise<import("@/session/tools").ResolvedTools>
      install: (name: string, source: string) => Promise<void>
    }) => Promise<void>,
  ) {
    const { withIsolatedDatabase } = await import("../helpers/sqlite")
    await withIsolatedDatabase(async () => {
      const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-mod-e2e-")))
      const [{ Effect }, { Session }, { Agent }, { resolveTools }, effect] = await Promise.all([
        import("effect"),
        import("@/session"),
        import("@/agent/agent"),
        import("@/session/tools"),
        import("@/effect"),
      ])
      try {
        await Instance.provide({
          directory,
          fn: async () => {
            const runSession = <A, E>(value: EffectNs.Effect<A, E, any>) =>
              effect.runPromiseWithLayer(Session.defaultLayer, effect.withCurrentInstance(value))
            const created = await runSession(
              Effect.gen(function* () {
                const service = yield* Session.Service
                return yield* service.createNext({ directory, title: "mod e2e" })
              }),
            )
            const session = () =>
              runSession(
                Effect.gen(function* () {
                  const service = yield* Session.Service
                  return yield* service.get(created.id)
                }),
              )
            const agent = await effect.runPromiseWithLayer(
              Agent.defaultLayer,
              effect.withCurrentInstance(
                Effect.gen(function* () {
                  const service = yield* Agent.Service
                  return yield* service.get("build")
                }),
              ),
            )
            if (!agent) throw new Error("build agent missing")
            const resolve = async () =>
              resolveTools({
                agent,
                model: anthropic as unknown as import("@/provider/provider").Provider.Model,
                session: await session(),
                processor: {
                  message: { id: "message_e2e" } as import("@/session/message-v2").MessageV2.Assistant,
                  partFromToolCall: () => undefined,
                },
                bypassAgentCheck: false,
              })
            const install = async (name: string, source: string) => {
              const def = await PluginTool.init()
              const { ctx } = makeToolContext({ sessionID: created.id })
              const result = await def.executeAsync({ action: "create", name, source }, ctx)
              if (!result.metadata.loaded) throw new Error(result.output)
            }
            await fn({ directory, resolve, install })
          },
        })
      } finally {
        await Instance.disposeAll().catch(() => undefined)
        await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
      }
    })
  }

  const run = async (tools: import("@/session/tools").ResolvedTools["tools"], args: Record<string, unknown>) => {
    const read = tools.read as unknown as { execute: (args: unknown, options: unknown) => Promise<{ output: string }> }
    return read.execute(args, callOptions())
  }

  it("a mod refuses, rewrites and describes real tool calls; an engine error is untouched", async () => {
    await withSession(async ({ directory, resolve, install }) => {
      await Bun.write(path.join(directory, "a.txt"), "alpha\n")
      await Bun.write(path.join(directory, "b.txt"), "beta\n")
      await Bun.write(path.join(directory, "secrets.env"), "SECRET=1\n")

      // Before any mod: the tool behaves as it always did.
      const before = await resolve()
      expect((await run(before.tools, { filePath: path.join(directory, "a.txt") })).output).toContain("alpha")
      const plainDescription = before.tools.read.description ?? ""

      await install(
        "read-policy",
        `export function register(on) {
  on("tool.call", { tool: "read", filePath: /secrets\\.env$/ }, async () => ({ deny: "Secrets are off limits." }))
  on("tool.call", { tool: "read", filePath: /a\\.txt$/ }, async ($, e, next) => next({ ...e, filePath: e.filePath.replace("a.txt", "b.txt") }))
  on("tool.describe", { tool: "read" }, async ($, e, next) => ({ description: e.description + " Reads are audited." }))
}`,
      )

      const after = await resolve()
      expect(after.tools.read.description).toBe(plainDescription + " Reads are audited.")

      // Rewritten arguments reach the real tool.
      expect((await run(after.tools, { filePath: path.join(directory, "a.txt") })).output).toContain("beta")

      // Refused: the real tool never ran, and the model reads the reason as the tool's result.
      const refused = await run(after.tools, { filePath: path.join(directory, "secrets.env") })
      expect(refused.output).toBe("Secrets are off limits.")
      expect(refused.output).not.toContain("SECRET")

      // The tool's own error is exactly what it threw without mods.
      await expect(run(after.tools, { filePath: path.join(directory, "missing.txt") })).rejects.toThrow()
    })
  })
})
