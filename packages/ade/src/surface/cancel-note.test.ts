import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * Review area 2, MEDIO: the note of an `ade-msg cancel` was typed at once,
 * checked only against a permission prompt, so it landed mid-turn or inside
 * the draft the user was writing. It is held like every other note, and the
 * round types it when the session is free and its line is empty (`freeNow`).
 *
 * The handler lives inside the workbench and cannot be called from a test.
 */
test("the cancel note is held for the round, not typed on the spot", () => {
  const source = readFileSync(join(import.meta.dir, "workbench.tsx"), "utf8")
  const start = source.indexOf('if (message.kind === "cancel") {')
  const branch = source.slice(start, source.indexOf('if (message.kind === "kv") {', start))
  expect(branch).toContain("heldLines.push({ paneId: request.to, text: formatCancel(request.id, sender) })")
  expect(branch).not.toContain("typeLine(")
})
