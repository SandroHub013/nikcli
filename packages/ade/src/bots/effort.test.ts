import { describe, expect, test } from "bun:test"
import type { ConfigProviders } from "@nikcli-ai/sdk/client"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { effortChoices, effortToSave, effortToSend, modelVariants } from "./effort"

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

describe("the efforts the bot form offers", () => {
  const FIXED = ["minimal", "low", "medium", "high", "max"]

  test("a nikcli model's variants, and nothing of the fixed list", () => {
    expect(effortChoices({ nikcli: true, fixed: FIXED, variants: ["none", "thinking"], saved: "" })).toEqual({ options: ["none", "thinking"], none: false })
    expect(effortChoices({ nikcli: true, fixed: FIXED, variants: ["none", "thinking"], saved: "thinking" })).toEqual({ options: ["none", "thinking"], none: false })
  })

  test("a saved value the model does not have shows the default, saying so", () => {
    expect(effortChoices({ nikcli: true, fixed: FIXED, variants: ["none", "thinking"], saved: "medium" })).toEqual({
      options: ["none", "thinking"],
      stale: "medium",
      none: false,
    })
    expect(effortChoices({ nikcli: true, fixed: FIXED, variants: [], saved: "high" })).toEqual({ options: [], stale: "high", none: true })
    expect(effortChoices({ nikcli: true, fixed: FIXED, variants: [], saved: "" })).toEqual({ options: [], none: true })
  })

  test("variants not known offer only the default, and keep what is saved", () => {
    expect(effortChoices({ nikcli: true, fixed: FIXED, variants: undefined, saved: "" })).toEqual({ options: [], none: false })
    expect(effortChoices({ nikcli: true, fixed: FIXED, variants: undefined, saved: "high" })).toEqual({ options: [], kept: "high", none: false })
  })

  test("Claude Code's and Codex's fixed values stay, a value of their own kept", () => {
    const flags = ["low", "medium", "high", "xhigh", "max"]
    expect(effortChoices({ nikcli: false, fixed: flags, variants: undefined, saved: "" })).toEqual({ options: flags, none: false })
    expect(effortChoices({ nikcli: false, fixed: flags, variants: undefined, saved: "ultra" })).toEqual({ options: flags, kept: "ultra", none: false })
  })
})

/* Review of bot-sforzo, BASSO 2: a save with nothing touched put back a level the model does not have. */
describe("what a save writes of the effort", () => {
  test("nothing for a level the model does not have, nor for the default", () => {
    expect(effortToSave("high", "high")).toBeUndefined()
    expect(effortToSave(" high ", "high")).toBeUndefined()
    expect(effortToSave("", undefined)).toBeUndefined()
    expect(effortToSave("low", undefined)).toBe("low")
    // A level chosen after the stale one goes.
    expect(effortToSave("low", "high")).toBe("low")
  })

  test("both forms save through it, told by the field which level is stale", () => {
    const form = readFileSync(join(import.meta.dir, "bots.tsx"), "utf8")
    expect(form.split("onStale={setStaleEffort}").length - 1).toBe(2)
    expect(form).toContain("effort: effortToSave(effort(), staleEffort()),")
    expect(form).toContain("...(effortToSave(effort(), staleEffort()) ? { effort: effortToSave(effort(), staleEffort()) } : {}),")
    expect(form).toContain("createEffect(() => props.onStale?.(efforts().stale))")
    expect(form).toContain("staleEffort() !== undefined ||")
  })
})
