import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { setLocalePreference, t } from "../i18n"
import { addNotice, dismissClosedApprovals, unreadCount } from "../surface/notifications"
import { approvalBadge, approvalLine, freshApprovals, shouldNotifySystem, sourcesText, systemNotification } from "./approval-signal"
import { mergeApprovals, type ApprovalRequest } from "./approvals"
import { notifySystem, windowInFront } from "./system-notify"

setLocalePreference("it")

/*
 * The signal (choice 4): the badge on the Bot section, a line in the bell for each new request that goes when the
 * request does, and a system notification only when ADE is behind.
 */
const request = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  key: "ade:1",
  bot: "C:/p/a.md",
  botName: "alfa",
  source: "ade",
  permission: "bash",
  patterns: "git push --force",
  askedAt: 1000,
  expiresAt: 301_000,
  choices: ["once", "always", "reject"],
  answer: () => {},
  ...over,
})
const waiting = (...requests: ApprovalRequest[]) => mergeApprovals(requests)

describe("what is new", () => {
  test("a request is new once; the same asked by the phone too is still the same one", () => {
    const first = freshApprovals(new Set(), waiting(request()))
    expect(first.fresh).toHaveLength(1)
    const again = freshApprovals(first.seen, waiting(request(), request({ key: "tg:1", source: "telegram" })))
    expect(again.fresh).toEqual([])
    expect(again.seen.size).toBe(1)
  })

  test("a request that closed and is asked again is news again; another one is news", () => {
    const first = freshApprovals(new Set(), waiting(request()))
    const closed = freshApprovals(first.seen, [])
    expect(closed.seen.size).toBe(0)
    expect(freshApprovals(closed.seen, waiting(request())).fresh).toHaveLength(1)
    expect(freshApprovals(first.seen, waiting(request(), request({ key: "k2", patterns: "git reset --hard" }))).fresh).toHaveLength(1)
  })
})

describe("the badge", () => {
  test("nothing, not a zero, when nothing waits; the number and the attention when something does", () => {
    expect(approvalBadge([])).toEqual({ badge: undefined, attention: false })
    expect(approvalBadge(waiting(request(), request({ key: "k2", bot: "C:/p/b.md" })))).toEqual({ badge: 2, attention: true })
    // The same thing from two places is one.
    expect(approvalBadge(waiting(request(), request({ key: "tg", source: "telegram" }))).badge).toBe(1)
  })
})

describe("the words", () => {
  test("the line says whose bot and what it wants; the system notification has the app and the bot in the title", () => {
    const one = waiting(request())[0]!
    expect(approvalLine(one)).toBe("«alfa» aspetta te: vuole usare «bash» su «git push --force»")
    expect(systemNotification(one)).toEqual({ title: "ADE: «alfa» aspetta te", body: approvalLine(one) })
    setLocalePreference("en")
    expect(approvalLine(one)).toBe("“alfa” is waiting for you: it wants to use “bash” on “git push --force”")
    setLocalePreference("it")
  })

  test("where it came from, in words", () => {
    expect(sourcesText(["ade", "telegram"])).toBe(`${t("bots.waiting.fromAde")} · ${t("gateway.panel.platformTelegram")}`)
    expect(sourcesText(["fake"])).toBe("fake")
  })
})

describe("the bell", () => {
  test("a line per new request, with the bot to open and the request it is about", () => {
    const one = waiting(request())[0]!
    const list = addNotice([], { kind: "warning", text: approvalLine(one), bot: one.bot, approval: one.id, at: 1 })
    expect(list[0]).toMatchObject({ bot: "C:/p/a.md", approval: one.id, kind: "warning", read: false })
    expect(unreadCount(list)).toBe(1)
  })

  test("the line goes when the request is no longer waiting; other lines stay", () => {
    const one = waiting(request())[0]!
    let list = addNotice([], { kind: "error", text: "salvataggio non riuscito", at: 1 })
    list = addNotice(list, { kind: "warning", text: approvalLine(one), bot: one.bot, approval: one.id, at: 2 })
    expect(dismissClosedApprovals(list, new Set([one.id]))).toHaveLength(2)
    const left = dismissClosedApprovals(list, new Set())
    expect(left).toHaveLength(1)
    expect(left[0]!.text).toBe("salvataggio non riuscito")
  })
})

describe("the system notification", () => {
  test("only when ADE is behind", () => {
    expect(shouldNotifySystem(true)).toBe(false)
    expect(shouldNotifySystem(false)).toBe(true)
    expect(windowInFront({ hasFocus: () => true, visibilityState: "visible" })).toBe(true)
    expect(windowInFront({ hasFocus: () => false, visibilityState: "visible" })).toBe(false)
    expect(windowInFront({ hasFocus: () => true, visibilityState: "hidden" })).toBe(false)
    expect(windowInFront(undefined)).toBe(true)
  })

  test("it uses the browser's Notification only when it was already allowed, and never asks", () => {
    const made: [string, NotificationOptions | undefined][] = []
    class Fake {
      static permission = "granted"
      static requested = 0
      static requestPermission() {
        Fake.requested += 1
      }
      constructor(title: string, options?: NotificationOptions) {
        made.push([title, options])
      }
    }
    expect(notifySystem("ADE: «alfa» aspetta te", "corpo", "k", { Notification: Fake as unknown as typeof Notification })).toBe(true)
    expect(made).toEqual([["ADE: «alfa» aspetta te", { body: "corpo", tag: "k" }]])
    Fake.permission = "default"
    expect(notifySystem("x", "y", "k", { Notification: Fake as unknown as typeof Notification })).toBe(false)
    Fake.permission = "denied"
    expect(notifySystem("x", "y", "k", { Notification: Fake as unknown as typeof Notification })).toBe(false)
    expect(made).toHaveLength(1)
    expect(Fake.requested).toBe(0)
    expect(notifySystem("x", "y", "k", {})).toBe(false)
  })
})

describe("the shell draws it", () => {
  const shell = readFileSync(join(import.meta.dir, "../surface/workbench.tsx"), "utf8")

  test("lint: the Bot tab has the badge, the bell gets a line per new request and loses it with the request", () => {
    expect(shell).toContain('...(view === "bot" ? approvalBadge(waitingApprovals()) : {})')
    expect(shell).toContain("freshApprovals(approvalsSeen, waiting)")
    expect(shell).toContain("dismissClosedApprovals(list, seen)")
    expect(shell).toContain("approval: one.id")
  })

  test("lint: a system notification only when the window is not in front, and the row opens the bot", () => {
    expect(shell).toContain("shouldNotifySystem(windowInFront())")
    expect(shell).toContain("notifySystem(note.title, note.body, one.id)")
    expect(shell).toContain("openWaitingBot(bot())")
    expect(shell).toContain('t("bots.waiting.open")')
  })
})
