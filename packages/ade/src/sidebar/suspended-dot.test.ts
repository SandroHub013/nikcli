import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { deriveWorkspaces } from "../surface/state"
import type { Pane } from "../surface/state"
import { mapAgentStatus } from "./workspace-tree"

/* The sidebar dot of a suspended session (P1-C6): Verifiche found it green, as for a live one. */

test("the sidebar dot of a suspended session is grey and still, not the green of an available one", () => {
  expect(mapAgentStatus("idle", true)).toBe("sospesa")
  expect(mapAgentStatus("idle")).toBe("disponibile")
  const css = readFileSync(join(import.meta.dir, "sidebar.css"), "utf-8")
  const rule = /\[data-slot="agent-status-dot"\]\[data-agent-status="sospesa"\]\s*\{([^}]*)\}/.exec(css)
  expect(rule?.[1]).toContain("var(--ade-text-weak)")
  expect(css).not.toMatch(/data-agent-status="sospesa"\][^{]*\{[^}]*animation/)
})

test("the sidebar is told which sessions are suspended", () => {
  const pane = { id: "p1", title: "Claude", status: "idle", workspaceId: "w", agent: "claude-code", lines: [], suspended: true } as unknown as Pane
  const [workspace] = deriveWorkspaces([pane])
  expect(workspace?.sessions[0]?.suspended).toBe(true)
})
