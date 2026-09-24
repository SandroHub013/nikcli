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
      design: { k: "DS-A", variant: 2, path: "C:/Users/x/app/.ade/design/DS-A/2.html", title: "Vetro", name: "Due" },
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

/*
 * The Architect's BASSO 2 on D1: «Apri la variante» on the variant already
 * shown, after the frame had left it, did nothing: the pane compared the
 * address with its own and saw no change. Every open is now its own load.
 */
describe("opening the same variant again", () => {
  test("gives the pane a new load, even with the same address", async () => {
    const { openedDesign } = await import("./open-variant")
    const { designLoadKey } = await import("../browser/design-mode")
    const found = designForVariant(proposal, 1, ROOT, [ROOT])
    if (!found.ok) throw new Error("variant 1 should open")
    const first = openedDesign(found.design, undefined, 1_000)
    const again = openedDesign(found.design, undefined, 2_000)
    expect(first.path).toBe(again.path)
    expect(designLoadKey("http://ade-media.localhost/x.html", first.opened)).not.toBe(designLoadKey("http://ade-media.localhost/x.html", again.opened))
  })

  test("keeps the declared size", async () => {
    const { openedDesign } = await import("./open-variant")
    const found = designForVariant(proposal, 1, ROOT, [ROOT])
    if (!found.ok) throw new Error("variant 1 should open")
    expect(openedDesign(found.design, { width: 800, height: 600 }, 1).size).toEqual({ width: 800, height: 600 })
  })
})
