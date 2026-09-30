/** A signal that says «the plugins installed changed» (an install, an update switched on, an uninstall), so the open panels look again. */

import { createSignal } from "solid-js"

const [revision, setRevision] = createSignal(0)

/** Read inside an effect to run it again when the set of plugins changes. */
export const pluginsRevision = revision

export function pluginsChanged(): void {
  setRevision((value) => value + 1)
}
