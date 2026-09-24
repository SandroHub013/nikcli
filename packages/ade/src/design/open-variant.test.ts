import { describe, expect, test } from "bun:test"
import { addPane, createWorkbench, fromWorkspaceState, toWorkspaceState, type Pane } from "../surface/state"
import { parseWorkspace, serializeWorkspace } from "../session/persist"
import { declaredSize, designForVariant, designPaneFor } from "./open-variant"

/* D1: what `openDesignVariant` decides before it touches the workbench, and what the layout keeps. */

const ROOT = "C:/Users/x/app"
const proposal = {
  k: "DS-A",
  title: "Vetro",
  variants: [
    { name: "Uno", description: "", preview: ".ade/design/DS-A/1.html" },
    { name: "Due", description: "", preview: ".ade/design/DS-A/2.html" },
    { name: "Fuori", description: "", preview: "public/index.html" },
    { name: "Segreto", description: "", preview: ".ade/design/../../.env" },
  ],
}

describe("designForVariant", () => {
  test("a variant under .ade/design of an open project opens, by its path", () => {
    expect(designForVariant(proposal, 2, ROOT, [ROOT])).toEqual({
      ok: true,
      design: { k: "DS-A", variant: 2, path: "C:/Users/x/app/.ade/design/DS-A/2.html", title: "Vetro" },
    })
  })

  test("a page outside .ade/design, or climbing out of it, does not", () => {
    expect(designForVariant(proposal, 3, ROOT, [ROOT])).toEqual({ ok: false, reason: "not-design" })
    expect(designForVariant(proposal, 4, ROOT, [ROOT])).toEqual({ ok: false, reason: "not-design" })
  })

  test("a project not open in the window, or no project, does not", () => {
    expect(designForVariant(proposal, 1, ROOT, ["C:/Users/x/other"])).toEqual({ ok: false, reason: "not-design" })
    expect(designForVariant(proposal, 1, undefined, [ROOT])).toEqual({ ok: false, reason: "not-design" })
  })

  test("a variant that is not there", () => {
    expect(designForVariant(proposal, 0, ROOT, [ROOT])).toEqual({ ok: false, reason: "no-variant" })
    expect(designForVariant(proposal, 9, ROOT, [ROOT])).toEqual({ ok: false, reason: "no-variant" })
    expect(designForVariant(proposal, 1.5, ROOT, [ROOT])).toEqual({ ok: false, reason: "no-variant" })
  })
})

describe("declaredSize", () => {
  test("the page's ade-size", () => {
    expect(declaredSize(`<meta name="ade-size" content="1200x800">`)).toEqual({ width: 1200, height: 800 })
  })

  test("none declared, or out of range: undefined, so the pane uses its own width", () => {
    expect(declaredSize("<p>x</p>")).toBeUndefined()
    expect(declaredSize(`<meta name="ade-size" content="99999x800">`)).toBeUndefined()
  })
})

describe("the pane for a proposal", () => {
  const pane = (id: string, k?: string): Pane => ({
    id,
    title: id,
    status: "working",
    model: "—",
    mode: "browser",
    browserUrl: "http://ade-media.localhost/x.html",
    workspaceId: "proj",
    ...(k ? { browserDesign: { k, variant: 1, path: `${ROOT}/.ade/design/${k}/1.html` } } : {}),
    lines: [],
  })

  test("the one already showing the proposal is reused; another proposal's is not", () => {
    const panes = [pane("plain"), pane("b", "DS-B"), pane("a", "DS-A")]
    expect(designPaneFor(panes, "DS-A")?.id).toBe("a")
    expect(designPaneFor(panes, "DS-C")).toBeUndefined()
  })

  test("a Design-mode pane is not saved with the layout; an ordinary browser pane still is", () => {
    let wb = createWorkbench()
    wb = addPane(wb, pane("plain"))
    wb = addPane(wb, pane("a", "DS-A"))
    const saved = parseWorkspace(serializeWorkspace(toWorkspaceState(wb)))
    expect(saved?.browsers?.map((b) => b.id)).toEqual(["plain"])
    expect(fromWorkspaceState(saved!, "proj").panes.some((p) => p.browserDesign)).toBe(false)
  })
})
