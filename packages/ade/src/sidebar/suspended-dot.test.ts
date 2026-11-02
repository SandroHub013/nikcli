import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { deriveWorkspaces } from "../surface/state"
import type { Pane } from "../surface/state"
import { stateOfSession } from "../grid/pane-state"

/* The sidebar dot of a suspended session (P1-C6): Verifiche found it green, as for a live one. */

test("the sidebar icon of a suspended session is grey and still, not the green of an available one", () => {
  expect(stateOfSession({ status: "idle", suspended: true })).toBe("off")
  expect(stateOfSession({ status: "idle" })).toBe("idle")
  const css = readFileSync(join(import.meta.dir, "sidebar.css"), "utf-8")
  const rule = /\[data-slot="agent-status-dot"\]\[data-state="off"\]\s*\{([^}]*)\}/.exec(css)
  expect(rule?.[1]).toContain("var(--ade-state-off)")
  expect(css).not.toMatch(/data-state="off"\][^{]*\{[^}]*animation/)
})

test("the sidebar is told which sessions are suspended", () => {
  const pane = {
    id: "p1",
    title: "Claude",
    status: "idle",
    workspaceId: "w",
    agent: "claude-code",
    lines: [],
    suspended: true,
  } as unknown as Pane
  const [workspace] = deriveWorkspaces([pane])
  expect(workspace?.sessions[0]?.suspended).toBe(true)
})
