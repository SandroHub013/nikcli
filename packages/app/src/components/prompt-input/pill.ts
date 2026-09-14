/**
 * Which prompt parts are rendered as an atomic chip in the editor.
 *
 * A pill is one indivisible unit to the caret: arrowing past it moves over the
 * whole chip, and selecting inside it is not a thing. Six places had to agree on
 * which parts those are, and each wrote the answer out again as
 * `type === "file" || type === "agent"`. They agree today; the next part type
 * added is where they stop.
 */
export const PILL_TYPES = ["file", "agent"] as const

export type PillType = (typeof PILL_TYPES)[number]

export function isPillType(type: string | undefined): type is PillType {
  return type === "file" || type === "agent"
}

/** Whether a node in the editor is one of those chips. */
export function isPillNode(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return false
  return isPillType((node as HTMLElement).dataset.type)
}
