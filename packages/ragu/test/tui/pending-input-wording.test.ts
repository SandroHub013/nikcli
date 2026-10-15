import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/* Review of the UI, N25: «QUEUED sends at the next safe step» — the badge shouted in capitals. */
test("the pending input's badges are words, not shouting", () => {
  const card = readFileSync(join(import.meta.dir, "../../../tui/src/component/pending-input-card.tsx"), "utf8")
  expect(card).toContain("> Queued </span>")
  expect(card).toContain("> Steering </span>")
  expect(card).not.toMatch(/ QUEUED | STEERING /)
})
