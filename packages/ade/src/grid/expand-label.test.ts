import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * The expanded pane's button still said «Ingrandisci», while it puts the grid
 * back (Verifiche, mouse sessions, point 5). Read from the sources: a .tsx
 * rendered in bun test is compiled as React (solid-tsx-bun-test-trap).
 */
const dir = import.meta.dir
const actions = readFileSync(join(dir, "pane-actions.tsx"), "utf8")
const pane = readFileSync(join(dir, "pane.tsx"), "utf8")
const renderer = readFileSync(join(dir, "..", "surface", "pane-renderer.tsx"), "utf8")

describe("the expanded pane's button says it reduces", () => {
  test("the pane actions and the pane's own button pick the label from `expanded`", () => {
    expect(actions).toContain('aria-label={props.expanded ? t("pane.restore") : t("pane.expand")}')
    expect(pane).toContain(
      "<PaneActions onExpand={() => props.onExpand?.()} onClose={() => props.onClose?.()} expanded={props.expanded}>",
    )
    expect(pane).toContain('aria-label={props.expanded ? t("pane.restore") : t("pane.expand")}')
  })

  test("a session pane is told when it fills the grid", () => {
    expect(renderer).toContain("expanded={wb().expandedId === current().id}")
  })

  test("«Riduci», «Restore»", async () => {
    const it = (await import("../i18n/it")).it as Record<string, unknown>
    const en = (await import("../i18n/en")).en as Record<string, unknown>
    expect(it["pane.restore"]).toBe("Riduci")
    expect(en["pane.restore"]).toBe("Restore")
  })
})
