import { describe, expect, test } from "bun:test"
import {
  approvalSignature,
  createApprovalRegistry,
  decideApproval,
  mergeApprovals,
  remainingClock,
  remainingMs,
  type ApprovalChoice,
  type ApprovalRequest,
} from "./approvals"

/*
 * The one list of what waits for the user (choice 4): the panel's questions and the chats', together; the same
 * request from two places is one, and answering it answers both.
 */
const request = (over: Partial<ApprovalRequest> & { answers?: ApprovalChoice[] } = {}): ApprovalRequest => {
  const { answers, ...rest } = over
  return {
    key: "ade:A:1",
    bot: "C:/p/a.md",
    botName: "alfa",
    source: "ade",
    permission: "bash",
    patterns: "git push --force",
    reason: "riscrive la storia",
    askedAt: 1000,
    expiresAt: 301_000,
    choices: ["once", "always", "reject"],
    answer: (choice) => void answers?.push(choice),
    ...rest,
  }
}

describe("merging", () => {
  test("the same thing asked by the same bot from two places is one, with both sources", () => {
    const merged = mergeApprovals([
      request({ key: "telegram:1", source: "telegram", askedAt: 2000, expiresAt: 302_000, choices: ["once", "reject"] }),
      request({ key: "ade:1" }),
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ id: approvalSignature(request()), sources: ["ade", "telegram"], askedAt: 1000, expiresAt: 301_000 })
    // «Sempre» is the panel's only: it is not offered when a phone's question is in the same request.
    expect(merged[0]!.choices).toEqual(["once", "reject"])
    expect(merged[0]!.members).toHaveLength(2)
  })

  test("another bot, another command, or another permission is another request", () => {
    const merged = mergeApprovals([
      request({ key: "a" }),
      request({ key: "b", bot: "C:/p/b.md" }),
      request({ key: "c", patterns: "git reset --hard" }),
      request({ key: "d", permission: "external_directory" }),
    ])
    expect(merged.map((one) => one.members[0]!.key)).toEqual(["a", "b", "c", "d"])
  })

  test("the same command with a stray space is the same; the earliest expiry decides", () => {
    const merged = mergeApprovals([
      request({ key: "a", expiresAt: 500_000 }),
      request({ key: "b", patterns: "git push --force ", expiresAt: 400_000 }),
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]!.expiresAt).toBe(400_000)
  })

  test("oldest first", () => {
    const merged = mergeApprovals([request({ key: "late", bot: "x", askedAt: 9 }), request({ key: "early", bot: "y", askedAt: 1 })])
    expect(merged.map((one) => one.members[0]!.key)).toEqual(["early", "late"])
  })
})

describe("deciding", () => {
  test("an answer reaches every member, so the phone has it as if it had been given there", () => {
    const answers: ApprovalChoice[] = []
    const phone: ApprovalChoice[] = []
    const [one] = mergeApprovals([
      request({ key: "ade:1", answers, choices: ["once", "reject"] }),
      request({ key: "tg:1", source: "telegram", answers: phone, choices: ["once", "reject"] }),
    ])
    expect(decideApproval(one!, "once")).toBe(true)
    expect(answers).toEqual(["once"])
    expect(phone).toEqual(["once"])
  })

  test("a choice a member does not take is not given to any", () => {
    const answers: ApprovalChoice[] = []
    const phone: ApprovalChoice[] = []
    const [one] = mergeApprovals([
      request({ key: "ade:1", answers }),
      request({ key: "tg:1", source: "telegram", answers: phone, choices: ["once", "reject"] }),
    ])
    expect(decideApproval(one!, "always")).toBe(false)
    expect(answers).toEqual([])
    expect(phone).toEqual([])
  })
})

describe("the time left", () => {
  test("never below zero, and as a clock", () => {
    const one = mergeApprovals([request({ expiresAt: 301_000 })])[0]!
    expect(remainingMs(one, 1000)).toBe(300_000)
    expect(remainingClock(one, 1000)).toBe("5:00")
    expect(remainingClock(one, 61_000)).toBe("4:00")
    expect(remainingClock(one, 296_001)).toBe("0:05")
    expect(remainingMs(one, 999_999)).toBe(0)
    expect(remainingClock(one, 999_999)).toBe("0:00")
  })
})

describe("the registry", () => {
  test("opened, listed, closed once; a newer entry under the same key is not closed by the old one's closer", () => {
    let changes = 0
    const registry = createApprovalRegistry(() => void changes++)
    const first = request({ key: "k" })
    const closeFirst = registry.open(first)
    expect(registry.list()).toEqual([first])
    const second = request({ key: "k", patterns: "other" })
    registry.open(second)
    closeFirst()
    expect(registry.list()).toEqual([second])
    registry.close("k")
    registry.close("k")
    expect(registry.list()).toEqual([])
    expect(changes).toBe(3)
  })
})
