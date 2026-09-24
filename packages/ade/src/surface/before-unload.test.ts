import { describe, expect, test } from "bun:test"
import { translate } from "../i18n"
import {
  mustConfirmLeaving,
  shouldConfirmWindowClose,
  closeConfirmationMessage,
  countWorkingSessions,
  isWorkingAgentPane,
} from "./before-unload"

describe("leaving the page (audit 0.7.7, MEDIO 16)", () => {
  test("a running session asks first: a reload would end it mid-turn", () => {
    expect(mustConfirmLeaving({ unsavedBuffers: 0, runningSessions: 1 })).toBe(true)
  })

  test("an unsaved buffer asks, as before", () => {
    expect(mustConfirmLeaving({ unsavedBuffers: 2, runningSessions: 0 })).toBe(true)
  })

  test("nothing to lose: no question", () => {
    expect(mustConfirmLeaving({ unsavedBuffers: 0, runningSessions: 0 })).toBe(false)
  })
})

describe("closing the window (D81, d81-chiusura - option B)", () => {
  test("0 sessions working: closes immediately without asking", () => {
    expect(shouldConfirmWindowClose({ working: 0 })).toBe(false)
  })

  test("1 session working: asks confirmation with singular phrasing", () => {
    expect(shouldConfirmWindowClose({ working: 1 })).toBe(true)
    expect(closeConfirmationMessage(1)).toBe("1 sessione sta lavorando. Chiudere lo stesso?")
  })

  test("multiple sessions working: asks confirmation with plural phrasing", () => {
    expect(shouldConfirmWindowClose({ working: 3 })).toBe(true)
    expect(closeConfirmationMessage(3)).toBe("3 sessioni stanno lavorando. Chiudere lo stesso?")
  })
})

describe("counting active working sessions for window close (D81)", () => {
  test("un terminale aperto non chiede niente (non conta come sessione al lavoro)", () => {
    const running = new Set(["term-1"])
    const panes = [
      { id: "term-1", title: "cmd", agent: "terminal", status: "working" as const },
    ]
    const working = countWorkingSessions(panes, running)
    expect(working).toBe(0)
    expect(shouldConfirmWindowClose({ working })).toBe(false)
  })

  test("una sessione ferma non chiede niente", () => {
    const running = new Set(["session-idle"])
    const panes = [
      { id: "session-idle", title: "Claude", agent: "claude-code", status: "idle" as const },
    ]
    const working = countWorkingSessions(panes, running)
    expect(working).toBe(0)
    expect(shouldConfirmWindowClose({ working })).toBe(false)
  })

  test("2 sessioni ferme piu' 1 terminale non chiedono niente (chiusura immediata)", () => {
    const running = new Set(["idle-1", "idle-2", "term-1"])
    const panes = [
      { id: "idle-1", title: "Claude", agent: "claude-code", status: "idle" as const },
      { id: "idle-2", title: "Codex", agent: "codex", status: "idle" as const },
      { id: "term-1", title: "Terminal", agent: "terminal", status: "working" as const },
    ]
    const working = countWorkingSessions(panes, running)
    expect(working).toBe(0)
    expect(shouldConfirmWindowClose({ working })).toBe(false)
  })

  test("una sessione al lavoro chiede conferma", () => {
    const running = new Set(["session-working"])
    const panes = [
      { id: "session-working", title: "Claude", agent: "claude-code", status: "working" as const },
    ]
    const working = countWorkingSessions(panes, running)
    expect(working).toBe(1)
    expect(shouldConfirmWindowClose({ working })).toBe(true)
    expect(closeConfirmationMessage(working)).toBe("1 sessione sta lavorando. Chiudere lo stesso?")
  })

  test("una sessione con status waiting (permesso aperto a meta' turno) chiede conferma", () => {
    const running = new Set(["session-waiting"])
    const panes = [
      { id: "session-waiting", title: "Codex", agent: "codex", status: "waiting" as const },
    ]
    const working = countWorkingSessions(panes, running)
    expect(working).toBe(1)
    expect(shouldConfirmWindowClose({ working })).toBe(true)
    expect(closeConfirmationMessage(working)).toBe("1 sessione sta lavorando. Chiudere lo stesso?")
  })

  test("un processo morto o non presente in running non conta come al lavoro", () => {
    const running = new Set<string>() // empty running map
    const panes = [
      { id: "session-dead", title: "OpenCode", agent: "opencode", status: "working" as const },
    ]
    const working = countWorkingSessions(panes, running)
    expect(working).toBe(0)
    expect(shouldConfirmWindowClose({ working })).toBe(false)
  })

  test("pannelli non agente (browser, video) non contano come sessioni al lavoro", () => {
    const running = new Set(["browser-1", "video-1"])
    const panes = [
      { id: "browser-1", title: "Browser", browserUrl: "http://localhost:3000", status: "working" as const },
      { id: "video-1", title: "Video", mode: "video", status: "working" as const },
    ]
    const working = countWorkingSessions(panes, running)
    expect(working).toBe(0)
    expect(shouldConfirmWindowClose({ working })).toBe(false)
  })

  test("isWorkingAgentPane helper matches working/waiting agent panes alive in running", () => {
    const running = new Set(["p1", "p2", "p3", "p4", "p5"])
    expect(isWorkingAgentPane({ id: "p1", agent: "claude-code", status: "working" }, running)).toBe(true)
    expect(isWorkingAgentPane({ id: "p2", model: "codex", status: "waiting" }, running)).toBe(true)
    expect(isWorkingAgentPane({ id: "p3", agent: "claude-code", status: "idle" }, running)).toBe(false)
    expect(isWorkingAgentPane({ id: "p4", agent: "terminal", status: "working" }, running)).toBe(false)
    expect(isWorkingAgentPane({ id: "p5", mode: "browser", browserUrl: "http://test", status: "working" }, running)).toBe(false)
    expect(isWorkingAgentPane({ id: "p-missing", agent: "claude-code", status: "working" }, running)).toBe(false)
  })

  test("English localization of window close confirmation", () => {
    expect(translate("en", "window.closeConfirm.message", 1)).toBe("1 session is working. Close anyway?")
    expect(translate("en", "window.closeConfirm.message", 3)).toBe("3 sessions are working. Close anyway?")
    expect(translate("en", "window.closeConfirm.ok")).toBe("Close")
    expect(translate("en", "window.closeConfirm.cancel")).toBe("Cancel")
  })
})
