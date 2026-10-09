import { afterAll, describe, expect, it } from "bun:test"
import { ModelsDev } from "@/provider/models"
import { Provider } from "@/provider/provider"
import { InstanceScope } from "@/effect"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"

process.env.RAGU_DISABLE_MODELS_FETCH = "1"

const testDirs: string[] = []

async function makeProjectDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ragu-provider-gateway-test-"))
  testDirs.push(dir)
  return dir
}

afterAll(async () => {
  for (const dir of testDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe("removal of inference gateway and free model", () => {
  it("does not inject ragu-inference or free model into the models catalog", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
      throw new Error(`Forbidden network request in tests: ${url}`)
    }) as unknown as typeof fetch

    try {
      const catalog = await ModelsDev.get()
      expect(catalog["ragu-inference"]).toBeUndefined()
      expect(catalog["nikcli-inference"]).toBeUndefined()

      for (const provider of Object.values(catalog)) {
        expect(provider.models["ragu-free"]).toBeUndefined()
        expect(provider.models["nikcli-free"]).toBeUndefined()
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("does not list ragu-inference or nikcli-inference and never calls Nik's hosts", async () => {
    const directory = await makeProjectDir()
    const originalFetch = globalThis.fetch
    // Listing providers refreshes models.dev and asks some providers for their models: those requests are expected
    // (and fail here, offline). What must never happen is a request to Nik's gateway.
    const requested: string[] = []

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
      requested.push(url)
      throw new Error(`Forbidden network request in tests: ${url}`)
    }) as unknown as typeof fetch

    try {
      const providers = await Effect.runPromise(
        InstanceScope.with(
          { directory },
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            return yield* provider.list()
          }).pipe(Effect.provide(Provider.defaultLayer)),
        ),
      )

      expect(providers["ragu-inference"]).toBeUndefined()
      expect(providers["nikcli-inference"]).toBeUndefined()
      expect(requested.filter((url) => /nikcli-ai\.dev|nikcli\.store/.test(url))).toEqual([])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
