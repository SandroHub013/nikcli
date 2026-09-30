import { describe, expect, it } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { SearchToolsTool } from "@/tool/search_tools"
import { Instance } from "@/project/instance"
import type { Tool } from "@/tool/tool"
import { makeToolContext } from "../helpers/tool-context"

/**
 * Deferred tools against a real session: what `resolveTools` offers, what
 * `search_tools` loads, and how a load persists into the next step.
 */
describe.serial("deferred tools", () => {
  const anthropic = { providerID: "anthropic", api: { id: "claude-opus-5" } }

  async function withSession(
    fn: (input: {
      sessionID: string
      session: () => Promise<import("@/session").Session.Info>
      resolve: () => Promise<import("@/session/tools").ResolvedTools>
      search: (query: string) => Promise<Awaited<ReturnType<Tool.Def["executeAsync"]>>>
    }) => Promise<void>,
  ) {
    const { withIsolatedDatabase } = await import("../helpers/sqlite")
    await withIsolatedDatabase(async () => {
      const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-deferred-tools-")))
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
            const runSession = <A, E>(value: import("effect").Effect.Effect<A, E, any>) =>
              effect.runPromiseWithLayer(Session.defaultLayer, effect.withCurrentInstance(value))
            const created = await runSession(
              Effect.gen(function* () {
                const service = yield* Session.Service
                return yield* service.createNext({ directory, title: "deferred tools test" })
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
                // `resolveTools` reads only the provider and api id off the model.
                model: anthropic as unknown as import("@/provider/provider").Provider.Model,
                session: await session(),
                processor: {
                  message: { id: "message_test" } as import("@/session/message-v2").MessageV2.Assistant,
                  partFromToolCall: () => undefined,
                },
                bypassAgentCheck: false,
              })
            const def = await SearchToolsTool.init({ agent })
            const search = (query: string) => {
              const { ctx } = makeToolContext({ sessionID: created.id })
              return def.executeAsync({ query }, { ...ctx, extra: { model: anthropic } })
            }
            await fn({ sessionID: created.id, session, resolve, search })
          },
        })
      } finally {
        await Instance.disposeAll().catch(() => undefined)
        await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
      }
    })
  }

  const callOptions = () => ({ toolCallId: "call_test", abortSignal: new AbortController().signal, messages: [] })

  it("offers core tools, keeps the rest callable but deferred, and indexes them", async () => {
    await withSession(async ({ resolve }) => {
      const { tools, deferred } = await resolve()
      for (const id of ["read", "edit", "bash", "grep", "glob", "task", "search_tools", "monitor"]) {
        expect(tools[id]).toBeDefined()
        expect(deferred.has(id)).toBe(false)
      }
      for (const id of ["webfetch", "todoread", "generate_image", "opentui"]) {
        // Still in the map, so a call by name runs.
        expect(tools[id]).toBeDefined()
        expect(deferred.has(id)).toBe(true)
      }
      const description = tools.search_tools.description ?? ""
      expect(description).toMatch(/^- webfetch: \S/m)
      expect(description).toMatch(/^- opentui: \S/m)
      expect(description).not.toMatch(/^- read:/m)
    })
  })

  it("loads a deferred tool by name for the rest of the session", async () => {
    await withSession(async ({ session, resolve, search }) => {
      const result = await search("webfetch")
      expect(result.output).toContain("Loaded 1 tool")
      expect(result.metadata.loaded).toEqual(["webfetch"])
      expect((await session()).disabledTools?.webfetch).toBe(false)

      const { tools, deferred } = await resolve()
      expect(deferred.has("webfetch")).toBe(false)
      expect(tools.search_tools.description ?? "").not.toMatch(/^- webfetch:/m)

      // Loading again is a no-op, reported as such.
      const again = await search("webfetch")
      expect(again.output).toContain("Already in your toolset: webfetch")
    })
  })

  it("loads keyword matches only when the keyword is in the tool's name", async () => {
    await withSession(async ({ session, search }) => {
      const image = await search("image")
      expect(image.metadata.loaded).toEqual(["generate_image"])
      expect(image.output).toMatch(/^- generate_image \[loaded now\]:/m)

      // "url" appears only in descriptions: listed, not loaded.
      const url = await search("url")
      expect(url.metadata.loaded).toEqual([])
      expect(url.output).toContain("[deferred — load by name]")
      expect((await session()).disabledTools).toEqual({ generate_image: false })
    })
  })

  it("never loads a tool the user switched off", async () => {
    await withSession(async ({ sessionID, session, search, resolve }) => {
      const [{ Effect }, { Session }, effect] = await Promise.all([
        import("effect"),
        import("@/session"),
        import("@/effect"),
      ])
      await effect.runPromiseWithLayer(
        Session.defaultLayer,
        effect.withCurrentInstance(
          Effect.gen(function* () {
            const service = yield* Session.Service
            yield* service.update(sessionID, (draft) => {
              draft.disabledTools = { webfetch: true }
            })
          }),
        ),
      )
      const result = await search("webfetch")
      expect(result.output).toContain("Not available in this session: webfetch")
      expect((await session()).disabledTools?.webfetch).toBe(true)
      expect((await resolve()).tools.webfetch).toBeUndefined()
    })
  })

  it("loads a deferred tool the model calls by name", async () => {
    await withSession(async ({ session, resolve }) => {
      const { tools } = await resolve()
      await tools.todoread.execute!({}, callOptions())
      expect((await session()).disabledTools?.todoread).toBe(false)
      expect((await resolve()).deferred.has("todoread")).toBe(false)
    })
  })

  it("loads a deferred tool whose call was rejected, and says the retry will have its schema", async () => {
    await withSession(async ({ session, resolve }) => {
      const { tools } = await resolve()
      // What the repair in `LLM.stream` turns a schema-rejected call into.
      const result = (await tools.invalid.execute!({ tool: "webfetch", error: "url: Required" }, callOptions())) as {
        output: string
      }
      expect(result.output).toContain("url: Required")
      expect(result.output).toContain("`webfetch` was not loaded yet")
      expect((await session()).disabledTools?.webfetch).toBe(false)

      // An ordinary invalid call is left as it was.
      const plain = (await tools.invalid.execute!({ tool: "read", error: "filePath: Required" }, callOptions())) as {
        output: string
      }
      expect(plain.output).not.toContain("was not loaded yet")
    })
  })
})
