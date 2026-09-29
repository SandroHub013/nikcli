import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * A line of mail typed into a plain terminal pane is run by its shell as a
 * command. The rule itself is tested in `session/mailbox.test.ts`; what only
 * the workbench can show is where it is applied, and the delivery lives
 * inside it and cannot be called from a test.
 */
const source = readFileSync(join(import.meta.dir, "workbench.tsx"), "utf8")

test("a send or an ask to a shell is refused right after the target is resolved, before anything is typed or booked", () => {
  const start = source.indexOf("const target = resolveTarget(panes, message.to, message.from)")
  const refusal = source.indexOf("shellRefusal(message.kind, target.pane)", start)
  expect(start).toBeGreaterThan(0)
  expect(refusal).toBeGreaterThan(start)
  for (const later of ["openRequests.set(id", "deliverText(", "queueForSuspended(", "handoffs.set(id"]) {
    expect([later, source.indexOf(later, start) > refusal]).toEqual([later, true])
  }
})

test("the round never types a held line into a shell: it shows it as a notice and drops it", () => {
  const round = source.indexOf("for (const item of [...heldLines]) {")
  const shell = source.indexOf("!typesMailInto(agentOfPane(item.paneId))", round)
  const typed = source.indexOf("await freeNow(host, item.paneId)", round)
  expect(round).toBeGreaterThan(0)
  expect(shell).toBeGreaterThan(round)
  expect(typed).toBeGreaterThan(shell)
  const branch = source.slice(shell, typed)
  expect(branch).toContain("heldLines.splice(heldLines.indexOf(item), 1)")
  expect(branch).toContain('tellPane(item.paneId, t("note.mailNotTyped"')
  expect(branch).not.toContain("typeLine")
  expect(branch).not.toContain("deliverText")
})
