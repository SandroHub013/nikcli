import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { ToolRegistry } from "@/tool/registry"
import { InstanceScope } from "@/effect"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"

const originalExaKey = process.env["EXA_API_KEY"]
const originalParallelKey = process.env["PARALLEL_API_KEY"]
const originalFetch = globalThis.fetch

const testDirs: string[] = []

async function makeProjectDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ragu-websearch-gate-test-"))
  testDirs.push(dir)
  return dir
}

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalExaKey === undefined) {
    delete process.env["EXA_API_KEY"]
  } else {
    process.env["EXA_API_KEY"] = originalExaKey
  }
  if (originalParallelKey === undefined) {
    delete process.env["PARALLEL_API_KEY"]
  } else {
    process.env["PARALLEL_API_KEY"] = originalParallelKey
  }
})

afterAll(async () => {
  for (const dir of testDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe("websearch and codesearch Exa key gate", () => {
  it("does not register websearch or codesearch when no Exa key is configured", async () => {
    delete process.env["EXA_API_KEY"]
    delete process.env["PARALLEL_API_KEY"]
    const directory = await makeProjectDir()

    const tools = await Effect.runPromise(
      InstanceScope.with(
        { directory },
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          return yield* registry.ids()
        }).pipe(Effect.provide(ToolRegistry.defaultLayer)),
      ),
    )

    const ids = tools
    expect(ids.includes("websearch")).toBe(false)
    expect(ids.includes("codesearch")).toBe(false)
  })

  it("registers websearch and codesearch when EXA_API_KEY is present and never calls Nik hosts or external network", async () => {
    process.env["EXA_API_KEY"] = "test-exa-key"
    delete process.env["PARALLEL_API_KEY"]
    const directory = await makeProjectDir()

    let networkAttempted = false
    globalThis.fetch = (async (input: string | URL | Request) => {
      networkAttempted = true
      const url = input instanceof Request ? input.url : String(input)
      throw new Error(`Forbidden network request in tests: ${url}`)
    }) as unknown as typeof fetch

    const tools = await Effect.runPromise(
      InstanceScope.with(
        { directory },
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          return yield* registry.ids()
        }).pipe(Effect.provide(ToolRegistry.defaultLayer)),
      ),
    )

    const ids = tools
    expect(ids.includes("websearch")).toBe(true)
    expect(ids.includes("codesearch")).toBe(true)

    // Check that tools are available to non-ragu models as well
    const resolvedTools = await Effect.runPromise(
      InstanceScope.with(
        { directory },
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          return yield* registry.tools({ providerID: "anthropic", modelID: "claude-3-7-sonnet" })
        }).pipe(Effect.provide(ToolRegistry.defaultLayer)),
      ),
    )

    const resolvedIds = resolvedTools.map((t) => t.id)
    expect(resolvedIds.includes("websearch")).toBe(true)
    expect(resolvedIds.includes("codesearch")).toBe(true)
    expect(networkAttempted).toBe(false)
  })

  it("registers websearch but NOT codesearch when websearch.provider is parallel with an API key", async () => {
    delete process.env["EXA_API_KEY"]
    const directory = await makeProjectDir()
    await Bun.write(
      path.join(directory, "nikcli.json"),
      JSON.stringify({
        websearch: {
          provider: "parallel",
          apiKey: "test-parallel-key",
        },
      }),
    )

    const tools = await Effect.runPromise(
      InstanceScope.with(
        { directory },
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          return yield* registry.ids()
        }).pipe(Effect.provide(ToolRegistry.defaultLayer)),
      ),
    )

    const ids = tools
    expect(ids.includes("websearch")).toBe(true)
    expect(ids.includes("codesearch")).toBe(false)
  })

  it("registers websearch but NOT codesearch when websearch.provider is mcp with an endpoint URL", async () => {
    delete process.env["EXA_API_KEY"]
    const directory = await makeProjectDir()
    await Bun.write(
      path.join(directory, "nikcli.json"),
      JSON.stringify({
        websearch: {
          provider: "mcp",
          url: "https://mcp.custom.test/search",
        },
      }),
    )

    const tools = await Effect.runPromise(
      InstanceScope.with(
        { directory },
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          return yield* registry.ids()
        }).pipe(Effect.provide(ToolRegistry.defaultLayer)),
      ),
    )

    const ids = tools
    expect(ids.includes("websearch")).toBe(true)
    expect(ids.includes("codesearch")).toBe(false)
  })
})
