import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * Composer-chip, pezzo 3: the Chat's pickers are chips under the field. What
 * they list and send is proved on the functions (`picker.test.ts`,
 * `model-source.test.ts`, the store's variant test); these lints check that
 * the Chat is wired to them.
 */
const view = readFileSync(join(import.meta.dir, "chat.tsx"), "utf8")

function slice(from: string, to: string): string {
  const start = view.indexOf(from)
  expect(start).toBeGreaterThan(-1)
  const end = view.indexOf(to, start)
  expect(end).toBeGreaterThan(start)
  return view.slice(start, end)
}

describe("the Chat's composer", () => {
  test("lint: the agent, model and effort are chips in the row under the field, not selects in the head", () => {
    const head = slice('<header data-slot="chat-head">', "</header>")
    expect(head).not.toContain("<select")
    const row = slice('<div data-slot="chat-composer-row">', '<span data-slot="chat-composer-gap" />')
    for (const piece of ['kind="agent"', "<ModelPicker", "<EffortPicker", 'data-slot="chat-attach"']) expect(row).toContain(piece)
    // The field comes first, the chips under it.
    expect(view.indexOf('data-slot="chat-input"')).toBeLessThan(view.indexOf('data-slot="chat-composer-row"'))
  })

  test("lint: the model chip reads the catalog when it opens, and the effort sent is one the model has", () => {
    const row = slice('<div data-slot="chat-composer-row">', '<span data-slot="chat-composer-gap" />')
    expect(row).toContain("onOpen={() => void openCatalog()}")
    expect(row).toContain("onRetry={() => void openCatalog()}")
    expect(view).toContain("const variant = effortValue(effort(), levels()) || undefined")
    expect(view).toContain("attachmentParts(attachments()), variant)")
  })
})
