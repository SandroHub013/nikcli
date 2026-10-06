import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { closeSuspendedTree } from "../session/suspend"

/*
 * Full review 2026-10-06, sessioni 3: closing a pane, «Termina processo» and a relaunch killed only the
 * direct child. A Claude Code's MCP servers, a dev server or a waiting `ade-msg ask` stayed alive, and
 * the session had left the registry, so closing ADE could not find them either.
 */
describe("a pane's process is closed with everything it started", () => {
  test("every kill in the workbench goes through the tree", () => {
    const source = readFileSync(join(import.meta.dir, "workbench.tsx"), "utf8")
    // A bare `.kill()` kills the direct child only; the tree goes through `closeSuspendedTree`.
    expect(source.match(/\.kill\(\)/g) ?? []).toEqual([])
    // Closing, killing, relaunching and the voice's kill: the four ways a pane's process ends.
    expect(source.match(/closeSuspendedTree\(/g)?.length).toBeGreaterThanOrEqual(4)
  })

  test("the kill asks for the tree", async () => {
    const asked: unknown[] = []
    const session = {
      kill: (options?: { tree?: boolean }) => {
        asked.push(options)
        return Promise.resolve(true)
      },
    }
    expect(await closeSuspendedTree(session)).toBe(true)
    expect(asked).toEqual([{ tree: true }])
  })
})
