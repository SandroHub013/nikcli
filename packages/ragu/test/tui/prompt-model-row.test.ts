import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * Review of the UI, N20: the model row ran the cut model name into the provider's name ("Determinist…simulation Ragu
 * deterministi…"), so nobody could tell where one ended. A dot now sits between them, drawn only when a provider is named.
 */
const source = readFileSync(join(import.meta.dir, "../../../tui/src/component/prompt/index.tsx"), "utf8")

describe("the prompt's model row", () => {
  test("a dot separates the model from the provider", () => {
    const model = source.indexOf("footerModel(local.model.parsed().model")
    const dot = source.indexOf("<Show when={footerProvider(local.model.parsed().provider)}>", model)
    const provider = source.indexOf("{footerProvider(local.model.parsed().provider)}\n", dot)
    expect(model).toBeGreaterThan(0)
    expect(dot).toBeGreaterThan(model)
    expect(provider).toBeGreaterThan(dot)
    expect(source.slice(dot, provider)).toContain("·")
  })

  test("the dot never shrinks, so the provider is what gives way", () => {
    const dot = source.indexOf("<Show when={footerProvider(local.model.parsed().provider)}>")
    expect(source.slice(dot, dot + 220)).toContain("flexShrink={0}")
  })
})
