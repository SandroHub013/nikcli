/**
 * What `openDesignVariant` decides before it touches the workbench (D1).
 *
 * A variant opens in a browser pane in Design mode: the pane is given the
 * page's path, never a URL, and turns it into one only through
 * `designUrlFor`. This file says which path, whether it may be shown, the
 * size the page declares, and which pane is reused.
 */

import { designUrlFor } from "../browser/design-url"
import { resolvePreviewPath } from "./design-preview"
import type { DesignProposal } from "./state"

/** What a Design-mode pane keeps in the workbench: the rest (`roots`) is read when it is drawn. */
export interface PaneDesign {
  readonly k: string
  readonly variant: number
  readonly path: string
  readonly title?: string
  /** The variant's name, for the note line. */
  readonly name?: string
  readonly size?: { readonly width: number; readonly height: number }
  /** When it was opened: every open is a load of its own, the same variant again included (BASSO 2). */
  readonly opened?: number
}

/** The design a pane is given when a variant is opened: its size, and the moment, so that opening it again reloads it. */
export function openedDesign(design: PaneDesign, size: PaneDesign["size"] | undefined, now: number): PaneDesign {
  return { ...design, ...(size ? { size } : {}), opened: now }
}

const MIN_SIDE = 120
const MAX_SIDE = 1600

/** The size a page declares in `<meta name="ade-size" content="WxH">`, or undefined when it declares none that fits. */
export function declaredSize(html: string): { width: number; height: number } | undefined {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/\bname\s*=\s*["']?ade-size["'\s>/]/i.test(tag)) continue
    const size = /\bcontent\s*=\s*["']\s*(\d+)\s*[x×]\s*(\d+)\s*["']/i.exec(tag)
    if (!size) return undefined
    const width = Number(size[1])
    const height = Number(size[2])
    const fits = (side: number) => side >= MIN_SIDE && side <= MAX_SIDE
    return fits(width) && fits(height) ? { width, height } : undefined
  }
  return undefined
}

/**
 * The design of variant `variant` (from 1) of `proposal`, or why it cannot
 * be opened: no such variant, no project, or a page that is not under
 * `.ade/design` of a project open in the window.
 */
export function designForVariant(
  proposal: Pick<DesignProposal, "k" | "title" | "variants">,
  variant: number,
  projectRoot: string | undefined,
  roots: readonly string[],
): { ok: true; design: PaneDesign } | { ok: false; reason: "no-variant" | "not-design" } {
  const entry = Number.isInteger(variant) ? proposal.variants[variant - 1] : undefined
  if (!entry) return { ok: false, reason: "no-variant" }
  const path = resolvePreviewPath(entry.preview, projectRoot)
  if (!projectRoot || designUrlFor(path, roots) === undefined) return { ok: false, reason: "not-design" }
  return {
    ok: true,
    design: {
      k: proposal.k,
      variant,
      path,
      ...(proposal.title ? { title: proposal.title } : {}),
      ...(entry.name ? { name: entry.name } : {}),
    },
  }
}

/** The pane to reuse for proposal `k`: the one already showing one of its variants. */
export function designPaneFor<P extends { id: string; browserDesign?: PaneDesign }>(panes: readonly P[], k: string): P | undefined {
  return panes.find((pane) => pane.browserDesign?.k === k)
}
