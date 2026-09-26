import { describe, expect, test } from "bun:test"
import { catalogFree, parseModelCatalog } from "./catalog"

/* The shape of `nikcli models opencode --verbose`, with made-up models. */
const record = (id: string, input: number, output: number) =>
  [
    `opencode/${id}`,
    "{",
    `  "id": "${id}",`,
    `  "providerID": "opencode",`,
    `  "capabilities": {`,
    `    "toolcall": true`,
    `  },`,
    `  "cost": {`,
    `    "input": ${input},`,
    `    "output": ${output}`,
    `  }`,
    "}",
  ].join("\n")

const OPENCODE = [record("mario-free", 0, 0), record("mario-pro", 2.5, 15)].join("\n")

describe("whether a routine's model is free, by nikcli's catalog (B11 review, M2)", () => {
  test("the catalog is read record by record", () => {
    const models = parseModelCatalog(`${OPENCODE}\nrumore\n`)
    expect([...models.keys()]).toEqual(["opencode/mario-free", "opencode/mario-pro"])
    expect(models.get("opencode/mario-pro")?.cost).toEqual({ input: 2.5, output: 15 })
  })

  test("a provider that prices honestly: 0 is free, a price is not, and a model it does not list is not", async () => {
    const asked: string[] = []
    const load = async (provider: string) => (asked.push(provider), OPENCODE)
    expect(await catalogFree("opencode/mario-free", load)).toBe(true)
    expect(await catalogFree("opencode/mario-pro", load)).toBe(false)
    expect(await catalogFree("opencode/altro", load)).toBe(false)
    expect(asked).toEqual(["opencode", "opencode", "opencode"])
  })

  test("the suffix is free without asking; elsewhere 0 is a missing price, and nikcli is not asked", async () => {
    const asked: string[] = []
    const load = async (provider: string) => (asked.push(provider), OPENCODE)
    expect(await catalogFree("openrouter/mario/modello:free", load)).toBe(true)
    expect(await catalogFree("openrouter/mario/modello", load)).toBe(false)
    expect(await catalogFree("modello", load)).toBe(false)
    expect(asked).toEqual([])
  })

  test("a catalog that cannot be read makes the model paid", async () => {
    expect(await catalogFree("opencode/mario-free", async () => "")).toBe(false)
    expect(await catalogFree("opencode/mario-free", async () => Promise.reject(new Error("no")))).toBe(false)
  })
})
