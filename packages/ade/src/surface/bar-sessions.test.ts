import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { emptyChatData, type ChatData } from "../chat/events"
import { CHAT_PERMISSION } from "../chat/rules"
import type { ChatState } from "../chat/store"
import { barSessionCount, type BarPane } from "./bar-sessions"

/* chat-bot-facili, prove: «0 sessioni» in the bar with a conversation in the Chat. */

const WORKBENCH = readFileSync(join(import.meta.dir, "workbench.tsx"), "utf8")

const PROJECT = { name: "proj", root: "C:\\lavoro\\proj" }

const pane = (patch: Partial<BarPane> = {}): BarPane =>
  ({ mode: "agent", workspaceId: "proj", projectRoot: "C:\\lavoro\\proj", ...patch }) as BarPane

const session = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, title: id, directory: "C:\\lavoro\\proj", time: { created: 1, updated: 2 }, ...extra }) as never

const chat = (status: ChatState["status"], patch: Partial<ChatData> = {}, directory = "C:/lavoro/proj") => ({
  state: { directory, status, data: { ...emptyChatData(), ...patch } },
})

const closed = chat("idle")

describe("the sessions the top bar counts", () => {
  test("a conversation in the Chat is a session, with no pane open", () => {
    const one = chat("live", { session: [session("ses_chat", { permission: [...CHAT_PERMISSION] })] })
    expect(barSessionCount([], PROJECT, one)).toBe(1)
  })

  test("a terminal's nikcli session is its pane, not a second session", () => {
    const listed = chat("live", {
      session: [session("ses_chat", { permission: [...CHAT_PERMISSION] }), session("ses_terminal")],
    })
    expect(barSessionCount([pane()], PROJECT, listed)).toBe(2)
  })

  test("only this project's: another project's panes and Chat folder do not count", () => {
    const panes = [pane(), pane({ workspaceId: "altro", projectRoot: "C:\\lavoro\\altro" })]
    const elsewhere = chat("live", { session: [session("ses_chat", { permission: [...CHAT_PERMISSION] })] }, "C:/lavoro/altro")
    expect(barSessionCount(panes, PROJECT, elsewhere)).toBe(1)
  })

  test("panels are not sessions, and a Chat not open on the folder adds nothing", () => {
    const panes = [pane(), pane({ mode: "browser", browserUrl: "https://example.com" }), pane({ filePath: "C:\\lavoro\\proj\\a.ts" })]
    expect(barSessionCount(panes, PROJECT, closed)).toBe(1)
  })

  test("with no project open, every agent pane counts, as before", () => {
    expect(barSessionCount([pane(), pane({ workspaceId: "altro", projectRoot: "C:\\altro" })], undefined, closed)).toBe(2)
  })

  test("lint: the bar's session count comes from barSessionCount", () => {
    expect(WORKBENCH).toContain("sessions={barSessionCount(wb().panes, project(), chatStore)}")
  })
})
