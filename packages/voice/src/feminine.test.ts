import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

/*
 * ADE speaks in the feminine in Italian. The catalogue test in packages/ade covers its own texts; the voice's own
 * sources hold spoken lines of their own (the bridge, the plan, the errors, the dialogue), and they said «Non sono
 * riuscito» and «Sono sveglio» in the masculine, on exactly the errors and the wake-up the user hears.
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

describe("the voice's own Italian lines are in the feminine", () => {
  test("no spoken line says «Non sono riuscito» or «Sono sveglio»", () => {
    const offenders = sources(join(import.meta.dir)).filter((path) =>
      /[Nn]on sono riuscito\b|\bSono sveglio\b/.test(readFileSync(path, "utf8")),
    )
    expect(offenders.map((path) => path.slice(import.meta.dir.length + 1))).toEqual([])
  })
})
