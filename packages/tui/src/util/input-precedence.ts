/** Escape belongs to a modal; Ctrl+C belongs to its focused editor. */

/** The layers that can claim an event, highest precedence first. */
export const INPUT_LAYERS = ["modal", "editable", "route", "application"] as const

export type InputLayer = (typeof INPUT_LAYERS)[number]

export type InputKey = {
  readonly name: string
  readonly ctrl?: boolean
}

/** Which layers are currently able to take an event. */
export type InputLayers = {
  /** A dialog or overlay is open. */
  readonly modal?: boolean
  /** A text input, editor, or other editable surface holds focus. */
  readonly editable?: boolean
  /** The active route or a plugin has registered a handler for this context. */
  readonly route?: boolean
  /** The application fallback. Always present; listed so the table is total. */
  readonly application?: boolean
}

/**
 * The single layer entitled to this event.
 *
 * Returns `undefined` only when nothing is active at all — including the
 * application fallback, which a caller may withhold deliberately (during
 * startup, say) and which is the one case where dropping the event is correct.
 */
export function ownerOf(active: InputLayers, key?: InputKey): InputLayer | undefined {
  if (key?.ctrl && key.name === "c" && active.editable) return "editable"
  for (const layer of INPUT_LAYERS) {
    if (active[layer]) return layer
  }
  return undefined
}

/**
 * Whether a layer may act on this event.
 *
 * The question every handler should ask before doing anything, instead of
 * checking the conditions it happens to know about. A handler that asks "is a
 * modal open" is guessing at the table; one that asks "am I the owner" is
 * reading it.
 */
export function owns(layer: InputLayer, active: InputLayers, key?: InputKey): boolean {
  return ownerOf(active, key) === layer
}

/**
 * The layers that were superseded, for diagnostics.
 *
 * When two handlers both fire on one event the useful question is which one
 * should not have, and that is this list.
 */
export function superseded(active: InputLayers, key?: InputKey): InputLayer[] {
  const owner = ownerOf(active, key)
  if (!owner) return []
  return INPUT_LAYERS.filter((layer) => layer !== owner && Boolean(active[layer]))
}
