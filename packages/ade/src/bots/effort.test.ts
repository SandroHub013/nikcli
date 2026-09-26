import { describe, expect, test } from "bun:test"
import type { ConfigProviders } from "@nikcli-ai/sdk/client"
import { effortToSend, modelVariants } from "./effort"

const providers = {
  providers: [
    {
      id: "openrouter",
      name: "OpenRouter",
      models: {
        "a/b:free": { id: "a/b:free", variants: { low: {}, medium: {}, high: {} } },
        "c/d:free": { id: "c/d:free" },
      },
    },
  ],
  default: {},
} as unknown as ConfigProviders

describe("a nikcli model's variants", () => {
  test("the configured ones, none for a model without, unknown for a model or catalog not there", () => {
    expect(modelVariants(providers, { providerID: "openrouter", modelID: "a/b:free" })).toEqual(["low", "medium", "high"])
    expect(modelVariants(providers, { providerID: "openrouter", modelID: "c/d:free" })).toEqual([])
    expect(modelVariants(providers, { providerID: "openrouter", modelID: "x/y" })).toBeUndefined()
    expect(modelVariants(providers, { providerID: "altro", modelID: "a/b:free" })).toBeUndefined()
    expect(modelVariants(undefined, { providerID: "openrouter", modelID: "a/b:free" })).toBeUndefined()
    expect(modelVariants(providers, undefined)).toBeUndefined()
  })
})

describe("the effort a turn sends", () => {
  test("one of the variants is sent; any other name is dropped, and said", () => {
    expect(effortToSend("high", ["low", "high"])).toEqual({ variant: "high" })
    expect(effortToSend("max", ["low", "high"])).toEqual({ dropped: "max" })
    expect(effortToSend("high", [])).toEqual({ dropped: "high" })
  })

  test("no effort sends nothing; variants not known leave it to the server", () => {
    expect(effortToSend(undefined, ["low"])).toEqual({})
    expect(effortToSend("  ", ["low"])).toEqual({})
    expect(effortToSend("high", undefined)).toEqual({ variant: "high" })
  })
})
