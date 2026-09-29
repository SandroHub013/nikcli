/**
 * Which of ADE's shortcuts the world may press, and how.
 *
 * The frame that has the focus takes every key, so ADE would be deaf while the
 * world is in front. The world forwards a chord (the keys and modifiers, since
 * it cannot know what the user has bound) and ADE reads it *as ADE's own
 * bindings do*: the chord becomes a command id, and only an id on this list is
 * run, with `runCommand`. No keyboard event is ever dispatched on the world's
 * behalf, so nothing that listens to keys — the voice shortcuts, a close, a
 * quit — can be reached by a chord the world invents.
 *
 * Navigation only: the palette, the section, the bar. A command that creates,
 * closes, records, speaks or leaves is not on the list and never will be by
 * default; `chords.test.ts` names some of them so adding one is a decision.
 */

import { resolveBinding, type Binding, type Platform } from "../keyboard/keymap"

/** The commands a forwarded chord may run: moving around ADE, and nothing that changes something. */
export const FORWARDABLE: ReadonlySet<string> = new Set(["palette.open", "view.toggle", "sidebar.toggle"])

export interface ForwardedChord {
  key: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

/**
 * The command id a chord from the world stands for, or undefined when it is
 * not one ADE binds or the command is not one the world may run.
 *
 * `bindings` are ADE's own, the ones its global key handler reads; the voice
 * chords are not among them, so they can never resolve here.
 */
export function forwardedCommand(
  bindings: Binding[],
  chord: ForwardedChord,
  platform: Platform,
): string | undefined {
  const id = resolveBinding(
    bindings,
    { key: chord.key, ctrlKey: chord.ctrl, metaKey: chord.meta, shiftKey: chord.shift, altKey: chord.alt },
    platform,
  )
  return id !== undefined && FORWARDABLE.has(id) ? id : undefined
}
