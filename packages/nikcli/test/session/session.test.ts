import { describe, expect, it } from "bun:test"
import { Session } from "@/session/index"
import { Provider } from "@/provider/provider"
import { runPromiseWithLayer } from "@/effect"
import { Effect } from "effect"

type UsageInput = Parameters<Session.Interface["getUsage"]>[0]

function usageModel(npm: string, cost?: Provider.Model["cost"]): Provider.Model {
  const io = {
    text: true,
    audio: false,
    image: false,
    video: false,
    pdf: false,
  }
  return Provider.Model.parse({
    id: "usage-characterization",
    providerID: "usage-characterization",
    api: { id: "usage-characterization", npm },
    name: "Usage characterization",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: io,
      output: io,
      interleaved: false,
    },
    cost: cost ?? { input: 2, output: 4, cache: { read: 1, write: 3 } },
    limit: { context: 1_000_000, output: 100_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  })
}

function getUsage(input: UsageInput) {
  return runPromiseWithLayer(
    Session.defaultLayer,
    Effect.gen(function* () {
      const session = yield* Session.Service
      return yield* session.getUsage(input)
    }),
  )
}

const missingUsage: UsageInput["usage"] = {
  inputTokens: undefined,
  outputTokens: undefined,
  totalTokens: undefined,
  reasoningTokens: undefined,
  cachedInputTokens: undefined,
}

describe("Session", () => {
  describe("EOT-11 usage characterization", () => {
    const normalizationCases: {
      label: string
      npm: string
      inputTokens: number
      metadata: UsageInput["metadata"]
      total: number
    }[] = [
      {
        label: "Anthropic excludes cache reads and writes from input and rebuilds total",
        npm: "@ai-sdk/anthropic",
        inputTokens: 1000,
        metadata: { anthropic: { cacheCreationInputTokens: 50 } },
        total: 1350,
      },
      {
        label: "OpenAI includes cache reads and writes in input and preserves total",
        npm: "@ai-sdk/openai",
        inputTokens: 1150,
        metadata: { nikcli: { cacheWriteInputTokens: 50 } },
        total: 9999,
      },
      {
        label: "Google includes cache reads and writes in input and preserves total",
        npm: "@ai-sdk/google",
        inputTokens: 1150,
        metadata: { nikcli: { cacheWriteInputTokens: 50 } },
        total: 9999,
      },
      {
        label: "Bedrock excludes cache reads but includes writes in input and rebuilds total",
        npm: "@ai-sdk/amazon-bedrock",
        inputTokens: 1050,
        metadata: { bedrock: { usage: { cacheWriteInputTokens: 50 } } },
        total: 1350,
      },
      {
        label: "Vertex Anthropic rebuilds total like Anthropic",
        npm: "@ai-sdk/google-vertex/anthropic",
        inputTokens: 1000,
        metadata: { anthropic: { cacheCreationInputTokens: 50 } },
        total: 1350,
      },
    ]

    it.each(normalizationCases)("$label", async ({ npm, inputTokens, metadata, total }) => {
      expect(
        await getUsage({
          model: usageModel(npm),
          usage: {
            ...missingUsage,
            inputTokens,
            outputTokens: 200,
            cachedInputTokens: 100,
            totalTokens: 9999,
          },
          metadata,
        }),
      ).toEqual({
        cost: 0.00305,
        tokens: {
          total,
          input: 1000,
          output: 200,
          reasoning: 0,
          cache: { read: 100, write: 50 },
        },
      })
    })

    it.each([0, 50])("native cache-write metadata wins over all legacy keys, including %s", async (write) => {
      const result = await getUsage({
        model: usageModel("@ai-sdk/amazon-bedrock"),
        usage: { ...missingUsage, inputTokens: 1000, cachedInputTokens: 100 },
        metadata: {
          nikcli: { cacheWriteInputTokens: write },
          anthropic: { cacheCreationInputTokens: 200 },
          bedrock: { usage: { cacheWriteInputTokens: 300 } },
          venice: { usage: { cacheCreationInputTokens: 400 } },
        },
      })
      expect(result).toEqual({
        cost: write === 0 ? 0.0021 : 0.00215,
        tokens: {
          total: 1100,
          input: 1000 - write,
          output: 0,
          reasoning: 0,
          cache: { read: 100, write },
        },
      })
    })

    it.each(["@ai-sdk/openai", "@ai-sdk/google", "@ai-sdk/anthropic", "@ai-sdk/amazon-bedrock"])(
      "missing usage fields become zero but total remains provider-dependent for %s",
      async (npm) => {
        expect(await getUsage({ model: usageModel(npm), usage: missingUsage })).toEqual({
          cost: 0,
          tokens: {
            total: npm === "@ai-sdk/anthropic" || npm === "@ai-sdk/amazon-bedrock" ? 0 : undefined,
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        })
      },
    )

    it("missing input with cache reads currently yields negative input and cost rather than clamping", async () => {
      expect(
        await getUsage({
          model: usageModel("@ai-sdk/openai"),
          usage: { ...missingUsage, cachedInputTokens: 100 },
        }),
      ).toEqual({
        cost: -0.0001,
        tokens: {
          total: undefined,
          input: -100,
          output: 0,
          reasoning: 0,
          cache: { read: 100, write: 0 },
        },
      })
    })

    it("prices reasoning at the output rate in addition to output without rewriting total", async () => {
      expect(
        await getUsage({
          model: usageModel("@ai-sdk/openai"),
          usage: {
            ...missingUsage,
            inputTokens: 1000,
            outputTokens: 200,
            reasoningTokens: 75,
            totalTokens: 1200,
          },
        }),
      ).toEqual({
        cost: 0.0031,
        tokens: {
          total: 1200,
          input: 1000,
          output: 200,
          reasoning: 75,
          cache: { read: 0, write: 0 },
        },
      })
    })

    it.each([0.12345, 0.000001])("OpenRouter prefers positive reported cost %s over catalog pricing", async (cost) => {
      const result = await getUsage({
        model: usageModel("@openrouter/ai-sdk-provider"),
        usage: {
          ...missingUsage,
          inputTokens: 1000,
          outputTokens: 200,
          totalTokens: 1200,
        },
        metadata: { openrouter: { usage: { cost } } },
      })
      expect(result).toEqual({
        cost,
        tokens: {
          total: 1200,
          input: 1000,
          output: 200,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      })
    })

    it.each([undefined, 0, -1, "0.123", null, Number.NaN, Infinity])(
      "OpenRouter falls back to catalog pricing for reported cost %s",
      async (cost) => {
        const result = await getUsage({
          model: usageModel("@openrouter/ai-sdk-provider"),
          usage: { ...missingUsage, inputTokens: 1000, outputTokens: 200 },
          metadata: cost === undefined ? undefined : { openrouter: { usage: { cost } } },
        })
        expect(result.cost).toBe(0.0028)
      },
    )

    it("ignores OpenRouter reported cost for other provider packages", async () => {
      const result = await getUsage({
        model: usageModel("@ai-sdk/openai"),
        usage: { ...missingUsage, inputTokens: 1000 },
        metadata: { openrouter: { usage: { cost: 99 } } },
      })
      expect(result.cost).toBe(0.002)
    })

    it.each([
      { inputTokens: 199_999, cost: 0.350718 },
      { inputTokens: 200_000, cost: 0.35072 },
      { inputTokens: 200_001, cost: 0.701444 },
    ])(
      "uses strictly >200k uncached input plus cache reads for pricing at $inputTokens",
      async ({ inputTokens, cost }) => {
        const result = await getUsage({
          model: usageModel("@ai-sdk/openai", {
            input: 2,
            output: 4,
            cache: { read: 1, write: 3 },
            experimentalOver200K: {
              input: 4,
              output: 8,
              cache: { read: 2, write: 6 },
            },
          }),
          usage: {
            inputTokens: inputTokens + 100,
            outputTokens: 100,
            cachedInputTokens: 50_000,
            reasoningTokens: 5,
            totalTokens: 999_999,
          },
          metadata: { nikcli: { cacheWriteInputTokens: 100 } },
        })
        expect(result).toEqual({
          cost,
          tokens: {
            total: 999_999,
            input: inputTokens - 50_000,
            output: 100,
            reasoning: 5,
            cache: { read: 50_000, write: 100 },
          },
        })
      },
    )

    it("uses base pricing above 200k when no high-context pricing exists", async () => {
      const result = await getUsage({
        model: usageModel("@ai-sdk/openai"),
        usage: { ...missingUsage, inputTokens: 200_001 },
      })
      expect(result.cost).toBe(0.400002)
    })
  })

  describe("Info schema", () => {
    it("validates valid session info", () => {
      const validInfo = {
        id: "ses_abc123",
        slug: "test-session",
        projectID: "proj_123",
        directory: "/test/dir",
        title: "Test Session",
        version: "1.0.0",
        time: {
          created: Date.now(),
          updated: Date.now(),
        },
      }

      const parsed = Session.Info.parse(validInfo)
      expect(parsed.slug).toBe("test-session")
    })

    it("rejects invalid id format", () => {
      const invalidInfo = {
        id: "invalid-id",
        slug: "test",
        projectID: "proj_123",
        directory: "/test",
        title: "Test",
        version: "1.0.0",
        time: { created: Date.now(), updated: Date.now() },
      }

      expect(() => Session.Info.parse(invalidInfo)).toThrow()
    })

    it("accepts optional fields", () => {
      const infoWithOptionals = {
        id: "ses_abc123",
        slug: "test",
        projectID: "proj_123",
        directory: "/test",
        title: "Test",
        version: "1.0.0",
        time: { created: Date.now(), updated: Date.now() },
        parentID: "ses_parent123",
        workspaceID: "wrk_123",
        skills: ["skill1", "skill2"],
      }

      const parsed = Session.Info.parse(infoWithOptionals)
      expect(parsed.parentID).toBe("ses_parent123")
      expect(parsed.skills).toEqual(["skill1", "skill2"])
    })
  })

  describe("isDefaultTitle", () => {
    it("returns true for default parent session titles", () => {
      const defaultTitle = "New session - 2024-01-01T00:00:00.000Z"
      expect(Session.isDefaultTitle(defaultTitle)).toBe(true)
    })

    it("returns true for default child session titles", () => {
      const childTitle = "Child session - 2024-06-20T15:45:30.123Z"
      expect(Session.isDefaultTitle(childTitle)).toBe(true)
    })

    it("returns false for custom titles", () => {
      expect(Session.isDefaultTitle("My Session")).toBe(false)
      expect(Session.isDefaultTitle("Working on feature")).toBe(false)
      expect(Session.isDefaultTitle("new session - 2024-01-01T00:00:00.000Z")).toBe(false)
    })

    it("returns false for partial matches", () => {
      expect(Session.isDefaultTitle("New session")).toBe(false)
      expect(Session.isDefaultTitle("session - 2024-01-01T00:00:00.000Z")).toBe(false)
    })
  })

  describe("ShareInfo schema", () => {
    it("validates valid share info", () => {
      const validShare = {
        id: "share_123",
        mode: "local" as const,
        url: "https://nikcli-ai.dev/s/share123",
      }

      const parsed = Session.ShareInfo.parse(validShare)
      expect(parsed.mode).toBe("local")
      expect(parsed.url).toBe("https://nikcli-ai.dev/s/share123")
    })

    it("accepts minimal share info with only url", () => {
      const minimalShare = { url: "https://example.com/share" }
      const parsed = Session.ShareInfo.parse(minimalShare)
      expect(parsed.url).toBe("https://example.com/share")
    })
  })

  describe("Event definitions", () => {
    it("has Created event defined", () => {
      expect(Session.Event.Created).toBeDefined()
      expect(Session.Event.Created.type).toBe("session.created")
    })

    it("has Updated event defined", () => {
      expect(Session.Event.Updated).toBeDefined()
      expect(Session.Event.Updated.type).toBe("session.updated")
    })

    it("has Deleted event defined", () => {
      expect(Session.Event.Deleted).toBeDefined()
      expect(Session.Event.Deleted.type).toBe("session.deleted")
    })

    it("has Diff event defined", () => {
      expect(Session.Event.Diff).toBeDefined()
      expect(Session.Event.Diff.type).toBe("session.diff")
    })

    it("has Error event defined", () => {
      expect(Session.Event.Error).toBeDefined()
      expect(Session.Event.Error.type).toBe("session.error")
    })
  })

  describe("service contract schemas", () => {
    it("CreateInput schema is defined", () => {
      expect(Session.CreateInput).toBeDefined()
    })

    it("ID schema is defined", () => {
      expect(Session.ID).toBeDefined()
    })
  })
})
