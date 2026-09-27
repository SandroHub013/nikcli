/**
 * The composer's keys and what a screen reader hears (C6), as data: the
 * component only acts on what these return.
 */

import type { Part } from "@nikcli-ai/sdk/httpapi"
import { t } from "../i18n"
import { messageError, type Turn } from "./sessions"

export interface ComposerKeyEvent {
  readonly key: string
  readonly shiftKey?: boolean
  readonly isComposing?: boolean
  readonly keyCode?: number
}

export type ComposerAction = "send" | "none" | "mentionNext" | "mentionPrevious" | "mentionPick" | "mentionClose"

/**
 * An input method (Japanese, Chinese, Korean, accents on some layouts) is
 * still composing: its Enter confirms the word, and must not send it half
 * written. WebView2 reports `isComposing`; 229 is what a keydown carries
 * while an IME holds it, on engines that do not.
 */
export function isComposing(event: ComposerKeyEvent): boolean {
  return event.isComposing === true || event.keyCode === 229
}

/** What a key does in the composer, with the `@` list open or not. */
export function composerAction(event: ComposerKeyEvent, mentionOpen: boolean): ComposerAction {
  if (isComposing(event)) return "none"
  if (mentionOpen) {
    if (event.key === "ArrowDown") return "mentionNext"
    if (event.key === "ArrowUp") return "mentionPrevious"
    if (event.key === "Enter" || event.key === "Tab") return "mentionPick"
    if (event.key === "Escape") return "mentionClose"
  }
  return event.key === "Enter" && !event.shiftKey ? "send" : "none"
}

/** Long enough to know what the answer says; the rest is on screen. */
const SPOKEN_MAX = 400

function textOf(parts: readonly Part[]): string {
  return parts
    .filter(
      (part): part is Extract<Part, { type: "text" }> =>
        part.type === "text" && !(part as { synthetic?: boolean }).synthetic,
    )
    .map((part) => part.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * What the live region says: the last answer once it is finished, or why it
 * failed. Keyed by the message, so the same answer is not read twice. Only an
 * answer finished at `since` or later: opening a session does not read out
 * its last answer again.
 */
export function liveAnnouncement(turns: readonly Turn[], since = 0): { id: string; text: string } | undefined {
  const last = turns.at(-1)
  if (!last || last.info.role !== "assistant") return undefined
  const completed = (last.info as { time?: { completed?: number } }).time?.completed
  if (!completed || completed < since) return undefined
  const error = messageError(last.info)
  if (error) return { id: last.info.id, text: t("chat.live.error", error.text) }
  const text = textOf(last.parts)
  if (!text) return undefined
  const spoken = text.length > SPOKEN_MAX ? `${text.slice(0, SPOKEN_MAX - 1)}…` : text
  return { id: last.info.id, text: t("chat.live.answer", spoken) }
}
