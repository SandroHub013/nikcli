import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { waitedFor } from "./list"

const NOW = new Date("2026-09-27T12:00:00.000Z")

describe("choices helpers", () => {
  test("how long an entry has waited", () => {
    expect(waitedFor("2026-09-27T11:59:40.000Z", NOW)).toBe("adesso")
    expect(waitedFor("2026-09-27T11:48:00.000Z", NOW)).toBe("12 min fa")
    expect(waitedFor("2026-09-27T09:00:00.000Z", NOW)).toBe("3 h fa")
    expect(waitedFor("2026-09-26T11:00:00.000Z", NOW)).toBe("1 giorno fa")
  })

  test("lint: the palette commands and voice open the sheets directly", () => {
    const workbench = readFileSync(join(import.meta.dir, "../surface/workbench.tsx"), "utf8")
    expect(workbench).toContain('} else if (id === "decisions.open") {')
    expect(workbench).toContain('} else if (id === "design.open") {')
    expect(workbench).toContain("start={choiceStart()}")
  })
})
