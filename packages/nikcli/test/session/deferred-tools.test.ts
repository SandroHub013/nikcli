import { describe, expect, it } from "bun:test"
import { removeTestDir } from "../helpers/fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { SearchToolsTool } from "@/tool/search_tools"
import { Instance } from "@/project/instance"
import type { Tool } from "@/tool/tool"
import { makeToolContext } from "../helpers/tool-context"

/**
 * Deferred tools against a real session: what `resolveTools` offers, what
 * `search_tools` says about the rest, and that neither a search nor a call
 * changes the toolset the provider sees (one cached prefix for the whole session).
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
        await removeTestDir(directory)
      }
    })
  }

  const callOptions = () => ({ toolCallId: "call_test", abortSignal: new AbortController().signal, messages: [] })

  const wire = (tools: Record<string, { description?: string }>) =>
    Object.entries(tools)
      .map(([id, tool]) => `${id} :: ${tool.description ?? ""}`)
      .join("\n")

  it("offers the core tools, leaves the deferred ones out and names them in search_tools", async () => {
    await withSession(async ({ resolve }) => {
      const { tools, deferred } = await resolve()
      for (const id of ["read", "edit", "bash", "grep", "glob", "task", "search_tools", "call_tool", "monitor", "todoread"]) {
        expect(tools[id]).toBeDefined()
      }
      for (const id of ["generate_image", "code_mode", "opentui"]) expect(tools[id]).toBeUndefined()
      // Nothing is "deferred but present": upstream's field stays, always empty.
      expect(deferred.size).toBe(0)
      const description = tools.search_tools.description ?? ""
      expect(description).toContain("generate_image")
      expect(description).toContain("call_tool")
    })
  })

  it("searching does not load anything: the toolset is byte-identical afterwards", async () => {
    await withSession(async ({ session, resolve, search }) => {
      const before = await resolve()
      const result = await search("generate_image")
      expect(result.output).toContain('call_tool({"name": "generate_image"')
      expect(result.output).toContain("parameters:")
      expect((await session()).disabledTools ?? {}).toEqual({})

      const after = await resolve()
      expect(Object.keys(after.tools)).toEqual(Object.keys(before.tools))
      expect(wire(after.tools)).toBe(wire(before.tools))
    })
  })

  it("answers a list of names and says which ones the session does not have", async () => {
    await withSession(async ({ search }) => {
      const result = await search("grep,generate_image,no_such_tool")
      expect(result.output).toContain("Already in your toolset: grep")
      expect(result.output).toContain('call_tool({"name": "generate_image"')
      expect(result.output).toContain("Not available in this session: no_such_tool")
    })
  })

  it("never offers a tool the user switched off", async () => {
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
              draft.disabledTools = { generate_image: true, webfetch: true }
            })
          }),
        ),
      )
      const result = await search("generate_image")
      expect(result.output).toContain("Not available in this session: generate_image")
      expect((await session()).disabledTools?.generate_image).toBe(true)
      const { tools } = await resolve()
      expect(tools.webfetch).toBeUndefined()

      // call_tool asks the same question, so it cannot be used to get around the switch.
      const blocked = (await tools.call_tool.execute!({ name: "generate_image", args: {} }, callOptions())) as {
        output: string
        metadata?: { ok?: boolean }
      }
      expect(blocked.metadata?.ok).toBe(false)
    })
  })

  it("runs a deferred tool through call_tool without touching the session's toolset", async () => {
    await withSession(async ({ session, resolve }) => {
      const before = await resolve()
      expect(before.tools.get_goal).toBeUndefined()
      const result = (await before.tools.call_tool.execute!({ name: "get_goal", args: {} }, callOptions())) as {
        title?: string
        output: string
        metadata?: { ok?: boolean }
      }
      // It ran: not "unknown tool", not "not available".
      expect(result.title ?? "").not.toContain("Unknown tool")
      expect(result.metadata?.ok).not.toBe(false)
      expect((await session()).disabledTools ?? {}).toEqual({})

      const after = await resolve()
      expect(wire(after.tools)).toBe(wire(before.tools))
    })
  })

  it("refuses a name the registry does not know and lists what exists", async () => {
    await withSession(async ({ resolve }) => {
      const { tools } = await resolve()
      const result = (await tools.call_tool.execute!({ name: "no_such_tool", args: {} }, callOptions())) as {
        output: string
      }
      expect(result.output).toContain('No registered tool is called "no_such_tool"')
    })
  })

  it("a direct call to a deferred tool is redirected to search_tools + call_tool, and loads nothing", async () => {
    await withSession(async ({ session, resolve }) => {
      const { tools } = await resolve()
      const result = (await tools.invalid.execute!({ tool: "generate_image", error: "prompt: Required" }, callOptions())) as {
        output: string
      }
      expect(result.output).toContain("registered but not in your tool schema")
      expect(result.output).toContain("call_tool")
      expect((await session()).disabledTools ?? {}).toEqual({})
    })
  })
})
