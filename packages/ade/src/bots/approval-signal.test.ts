import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { setLocalePreference, t } from "../i18n"
import { addNotice, dismissClosedApprovals, unreadCount } from "../surface/notifications"
import { approvalAction, approvalBadge, approvalLine, freshApprovals, shouldNotifySystem, sourcesText } from "./approval-signal"
import { mergeApprovals, type ApprovalRequest } from "./approvals"
import { notifySystem, windowInFront } from "./system-notify"

setLocalePreference("it")

/*
 * The signal (choice 4): the badge on the Bot section, a line in the bell for each new request that goes when the
 * request does, and the window flashing in the taskbar only when ADE is behind.
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
  test("the line says whose bot and what it wants", () => {
    const one = waiting(request())[0]!
    expect(approvalLine(one)).toBe("«alfa» aspetta te: vuole eseguire un comando (bash): «git push --force»")
    setLocalePreference("en")
    expect(approvalLine(one)).toBe("“alfa” is waiting for you: it wants to run a command (bash): “git push --force”")
    setLocalePreference("it")
  })

  test("P2-2: everyday words with the technical name in brackets; a permission with no words is named as ragu names it", () => {
    const one = (permission: string, patterns: string) => ({ permission, patterns })
    expect(approvalAction(one("bash", "ls"))).toBe("eseguire un comando (bash): «ls»")
    expect(approvalAction(one("external_directory", "C:/altro"))).toBe("scrivere fuori dal progetto (external_directory): «C:/altro»")
    expect(approvalAction(one("edit", "src/a.ts"))).toBe("modificare un file (edit): «src/a.ts»")
    expect(approvalAction(one("webfetch", "https://x.it"))).toBe("usare «webfetch» su «https://x.it»")
    expect(approvalAction(one("bash", "  "))).toBe("eseguire un comando (bash): «?»")
    setLocalePreference("en")
    expect(approvalAction(one("external_directory", "C:/other"))).toBe("write outside the project (external_directory): “C:/other”")
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

describe("the window flash", () => {
  test("only when ADE is behind", () => {
    expect(shouldNotifySystem(true)).toBe(false)
    expect(shouldNotifySystem(false)).toBe(true)
    expect(windowInFront({ hasFocus: () => true, visibilityState: "visible" })).toBe(true)
    expect(windowInFront({ hasFocus: () => false, visibilityState: "visible" })).toBe(false)
    expect(windowInFront({ hasFocus: () => true, visibilityState: "hidden" })).toBe(false)
    expect(windowInFront(undefined)).toBe(true)
  })

  test("the window flashes through the function it is given; a failure is no reason to lose the request", async () => {
    let flashes = 0
    expect(await notifySystem(async () => (flashes++, true))).toBe(true)
    expect(flashes).toBe(1)
    expect(await notifySystem(async () => false)).toBe(false)
    expect(await notifySystem(async () => Promise.reject(new Error("no window")))).toBe(false)
    // Outside the app (here) there is no window to flash, and nothing breaks.
    expect(await notifySystem()).toBe(false)
  })

  test("it is the taskbar flash host/ask.ts uses, only when the window has no focus, and the browser's Notification is gone", () => {
    const source = readFileSync(join(import.meta.dir, "system-notify.ts"), "utf8")
    expect(source).toContain("requestUserAttention(UserAttentionType.Critical)")
    expect(source).toContain("win.isFocused()")
    expect(source).not.toMatch(/new\s+Native|Notification\.permission|requestPermission/)
    expect(readFileSync(join(import.meta.dir, "../host/ask.ts"), "utf8")).toContain("requestUserAttention(UserAttentionType.Critical)")
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

  test("lint: the flash only when the window is not in front, and the row opens the bot", () => {
    expect(shell).toContain("shouldNotifySystem(windowInFront())")
    expect(shell).toContain("void notifySystem()")
    expect(shell).toContain("openWaitingBot(bot(), notice.room)")
    expect(shell).toContain('t("bots.waiting.openRoom")')
    expect(shell).toContain('t("bots.waiting.open")')
  })
})
