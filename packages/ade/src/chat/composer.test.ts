import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { t } from "../i18n"
import { composerAction, isComposing, liveAnnouncement } from "./composer"
import type { Turn } from "./sessions"

/* C6: the composer's keys, the IME, and what a screen reader hears. */

describe("the composer's keys", () => {
  test("Enter sends, Shift+Enter is a new line", () => {
    expect(composerAction({ key: "Enter" }, false)).toBe("send")
    expect(composerAction({ key: "Enter", shiftKey: true }, false)).toBe("none")
    expect(composerAction({ key: "a" }, false)).toBe("none")
  })

  test("with a composition open, Enter confirms the word and does not send", () => {
    expect(isComposing({ key: "Enter", isComposing: true })).toBe(true)
    expect(isComposing({ key: "Process", keyCode: 229 })).toBe(true)
    expect(composerAction({ key: "Enter", isComposing: true }, false)).toBe("none")
    expect(composerAction({ key: "Enter", keyCode: 229 }, false)).toBe("none")
    // Nor does it pick from the @ list.
    expect(composerAction({ key: "Enter", isComposing: true }, true)).toBe("none")
  })

  test("with the @ list open: arrows move, Enter and Tab pick, Escape closes", () => {
    expect(composerAction({ key: "ArrowDown" }, true)).toBe("mentionNext")
    expect(composerAction({ key: "ArrowUp" }, true)).toBe("mentionPrevious")
    expect(composerAction({ key: "Enter" }, true)).toBe("mentionPick")
    expect(composerAction({ key: "Tab" }, true)).toBe("mentionPick")
    expect(composerAction({ key: "Escape" }, true)).toBe("mentionClose")
    expect(composerAction({ key: "ArrowDown" }, false)).toBe("none")
  })

  test("lint: every key goes through composerAction, no hand-written Enter, and the view declares an aria-live region", () => {
    const view = readFileSync(new URL("./chat.tsx", import.meta.url), "utf8")
    expect(view).toMatch(/composerAction\(/)
    expect(view).not.toMatch(/event\.key === "Enter" && !event\.shiftKey/)
    expect(view).toMatch(/aria-live="polite"/)
  })
})

const assistant = (id: string, completed: boolean, error?: object) =>
  ({
    id,
    sessionID: "s",
    role: "assistant",
    time: completed ? { created: 1, completed: 2 } : { created: 1 },
    ...(error ? { error } : {}),
  }) as never
const textPart = (text: string, synthetic = false) => ({ id: "p", type: "text", text, synthetic }) as never

describe("what a screen reader hears", () => {
  test("a finished answer, once; nothing while it is written or after a question", () => {
    const writing: Turn[] = [{ info: assistant("m2", false), parts: [textPart("Sto scriv")] }]
    expect(liveAnnouncement(writing)).toBeUndefined()
    const done: Turn[] = [
      { info: assistant("m2", true), parts: [textPart("Fatto:\n  tre file."), textPart("interno", true)] },
    ]
    expect(liveAnnouncement(done)).toEqual({ id: "m2", text: t("chat.live.answer", "Fatto: tre file.") })
    const asked: Turn[] = [...done, { info: { id: "m3", role: "user" } as never, parts: [] }]
    expect(liveAnnouncement(asked)).toBeUndefined()
    // Finished before the session was opened on screen: not read again.
    expect(liveAnnouncement(done, 3)).toBeUndefined()
    expect(liveAnnouncement(done, 2)?.id).toBe("m2")
  })

  test("a failed answer says why; a long one is cut", () => {
    const failed: Turn[] = [{ info: assistant("m2", true, { name: "MessageAbortedError", data: {} }), parts: [] }]
    expect(liveAnnouncement(failed)!.text).toBe(t("chat.live.error", t("chat.error.aborted")))
    const long: Turn[] = [{ info: assistant("m4", true), parts: [textPart("x".repeat(1000))] }]
    expect(liveAnnouncement(long)!.text.length).toBeLessThan(450)
  })
})
