import { PermissionNext } from "@/permission/next"
import type { Session } from "."

/**
 * Titles for a session nobody is watching.
 *
 * `nikcli run` denies `question` on the sessions it creates (see `HEADLESS_PERMISSION` in
 * `cli/handlers/run.ts`): that rule is how the rest of the code already knows no human is on the
 * other end. Nobody reads a title there, and generating two of them (the session's and the
 * user message's) costs two model calls per run, so they are cut from the prompt text instead.
 * Interactive sessions do not carry the rule and keep model-written titles.
 */
export namespace HeadlessTitle {
  const MAX = 72
  const MIN_CUT = 24

  export function isHeadless(session: Pick<Session.Info, "permission">) {
    return PermissionNext.disabled(["question"], session.permission ?? []).has("question")
  }

  /**
   * First non-empty line, whitespace collapsed, cut on a word boundary. Returns undefined when
   * the text has nothing to title with.
   */
  export function fromPrompt(text: string): string | undefined {
    const line = text
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+/g, " ").trim())
      .find((l) => l.length > 0)
    if (!line) return undefined
    if (line.length <= MAX) return line
    const room = line.slice(0, MAX - 3)
    const space = room.lastIndexOf(" ")
    return (space >= MIN_CUT ? room.slice(0, space) : room).trimEnd() + "..."
  }
}
