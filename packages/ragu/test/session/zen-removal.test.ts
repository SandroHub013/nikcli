import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { SessionRetry } from "@/session/retry"
import { MessageV2 } from "@/session/message-v2"
import { nativeErrorToAPICallError } from "@/session/llm/llm-event-adapter"
import { InstanceScope } from "@/effect"
import { Instance } from "@/project/instance"
import { Provider } from "@/provider/provider"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"

const tempDirs: string[] = []

afterEach(async () => {
  await Instance.disposeAll().catch(() => undefined)
})

afterAll(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe("removal of Zen promotions and small_model fallback", () => {
  it("maps FreeUsageLimitError to plain message without credit URL", () => {
    const originalFetch = globalThis.fetch
    let nikHostCalled = false

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes("nikcli-ai.dev") || url.includes("nikcli.store")) {
        nikHostCalled = true
        throw new Error(`Forbidden request to Nik host: ${url}`)
      }
      return new Response("ok")
    }) as typeof fetch

    try {
      const errFromMessage = MessageV2.APIError.make({
        message: "FreeUsageLimitError reached",
        isRetryable: true,
      })
      const mappedMsg = SessionRetry.retryable(errFromMessage.toObject())
      expect(mappedMsg).toBe("Free usage exceeded")
      expect(mappedMsg?.includes("nikcli-ai.dev")).toBe(false)
      expect(mappedMsg?.includes("zen")).toBe(false)

      const errFromBody = MessageV2.APIError.make({
        message: "error occurred",
        responseBody: '{"error": "FreeUsageLimitError"}',
        isRetryable: true,
      })
      const mappedBody = SessionRetry.retryable(errFromBody.toObject())
      expect(mappedBody).toBe("Free usage exceeded")
      expect(mappedBody?.includes("nikcli-ai.dev")).toBe(false)
      expect(mappedBody?.includes("zen")).toBe(false)

      expect(nikHostCalled).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("native failure message for QuotaExceeded does not include Zen url", () => {
    // The runtime's failure carries its typed reason under `reason`, as in native-retry-after.test.ts.
    const error = {
      reason: {
        _tag: "QuotaExceeded",
        status: 429,
      },
    }
    const apiError = nativeErrorToAPICallError(error)
    expect(apiError?.message).toBe("Free usage exceeded")
    expect(apiError?.message.includes("nikcli-ai.dev")).toBe(false)
    expect(apiError?.message.includes("zen")).toBe(false)
  })

  it("never picks an unconfigured small_model via priority fallback", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ragu-zen-small-model-"))
    tempDirs.push(directory)

    await Bun.write(
      path.join(directory, "nikcli.json"),
      JSON.stringify(
        {
          provider: {
            "github-copilot": {
              name: "GitHub Copilot",
              api: "https://example.invalid/v1",
              npm: "@ai-sdk/openai-compatible",
              models: {
                "gpt-5": {
                  id: "gpt-5",
                  name: "GPT-5",
                  release_date: "2026-01-01",
                  limit: { context: 1024, output: 128 },
                  cost: { input: 0, output: 0 },
                },
              },
            },
          },
        },
        null,
        2,
      ),
    )

    const small = await Effect.runPromise(
      InstanceScope.with(
        { directory },
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          return yield* provider.getSmallModel("github-copilot")
        }).pipe(Effect.provide(Provider.defaultLayer)),
      ),
    )

    expect(small).toBeUndefined()
  })
})
