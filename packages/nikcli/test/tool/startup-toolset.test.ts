import { describe, expect, it } from "bun:test"
import { preserveTestEnv } from "../helpers/env"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "node:path"

/**
 * The startup regression, from `REVIEW-1` giro 1: `search_tools` used to call `registry.tools()`
 * from inside its own `init()`, and the registry initialises every tool including `search_tools`, so
 * each init waited on itself. The compiled binary made **zero provider requests in 182 s** and
 * `registry-effect-service` hung past 180 s.
 *
 * The fix reads the deferred names off the registry's constant, so nothing in `init` touches the
 * registry any more. This test builds the toolset the way startup does and fails on a timer rather
 * than hanging, because a hang in CI is a timeout with no explanation attached to it.
 */

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-boot-home-"))
process.env.NIKCLI_TEST_HOME = testHome
process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1"
process.env.XDG_DATA_HOME = path.join(testHome, "data")
process.env.XDG_CACHE_HOME = path.join(testHome, "cache")
process.env.XDG_CONFIG_HOME = path.join(testHome, "config")
process.env.XDG_STATE_HOME = path.join(testHome, "state")

preserveTestEnv([
  "NIKCLI_TEST_HOME",
  "NIKCLI_DISABLE_PROJECT_CONFIG",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
])

const { InstanceScope } = await import("@/effect")
const { ToolRegistry } = await import("@/tool/registry")

const projectDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-boot-project-")))

const within = <A>(ms: number, work: Promise<A>): Promise<{ value: A } | { timeout: true }> =>
  Promise.race([
    work.then((value) => ({ value })),
    new Promise<{ timeout: true }>((resolve) => setTimeout(() => resolve({ timeout: true }), ms)),
  ])

describe("startup", () => {
  it("builds the toolset with search_tools registered, on a timer", async () => {
    const built = await within(
      10_000,
      Effect.runPromise(
        InstanceScope.with(
          { directory: projectDir },
          Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            // Both entry points startup uses: the id list, and the resolved toolset with every
            // description and schema built.
            const ids = yield* registry.ids()
            const tools = yield* registry.tools({ providerID: "openai", modelID: "gpt-5" })
            return { ids, tools }
          }).pipe(Effect.provide(ToolRegistry.defaultLayer)),
        ),
      ),
    )

    if ("timeout" in built) {
      // Leave nothing running behind us.
      process.exit(1)
    }
    expect(built.value.ids).toContain("search_tools")
    expect(built.value.ids).toContain("call_tool")
    expect(built.value.tools.length).toBeGreaterThan(10)
  }, 20_000)

  it("initialises search_tools on its own, without the registry in the loop", async () => {
    const { SearchToolsTool } = await import("@/tool/search_tools")
    const inInstance = Effect.runPromise(
      InstanceScope.with(
        { directory: projectDir },
        Effect.promise(() => SearchToolsTool.init()),
      ),
    ) as Promise<{ description: string }>
    const result = await within(10_000, inInstance)
    if ("timeout" in result) process.exit(1)
    // And the text it produces is the one the schema will carry: no registry call shaped it.
    expect(result.value.description).toContain("call_tool")
    expect(result.value.description).toContain("code_mode")
  }, 20_000)
})
