import { describe, expect, test } from "bun:test"
import { t } from "../../i18n"
import { approveOnPhone, permissionAnswerer } from "./approval"

/*
 * B8d: the question on the phone is ragu's own event, with the whole
 * command: nothing read off a terminal, nothing cut, so nothing to warn about.
 */
describe("the command shown on the phone", () => {
  test("the whole command, as ragu asked about it, with no warning that it may be cut", async () => {
    let asked = ""
    const ask = async (question: string) => {
      asked = question
      return undefined
    }
    const permission = { permission: "bash", patterns: "echo $(rm -rf build) && ls", askedAt: 0 }
    const verdict = await approveOnPhone(permission, ask, new AbortController().signal)
    expect(asked).toBe(t("gateway.approve.question", "bash", "echo $(rm -rf build) && ls"))
    expect(verdict).toEqual({ answer: "reject", expired: true })
    expect(t("gateway.approve.question", "bash", "x")).not.toMatch(/incomplet|terminal/)
  })

  test("P2-3: what is hidden in the command is written out on the phone too, and the data is not changed", async () => {
    let asked = ""
    let detail = ""
    const ask = async (question: string, _choices: unknown, _signal: unknown, info?: { patterns: string }) => {
      asked = question
      detail = info?.patterns ?? ""
      return undefined
    }
    await approveOnPhone({ permission: "bash", patterns: "rm -rf ‮fsd/", askedAt: 0 }, ask, new AbortController().signal)
    expect(asked).toContain("⟨U+202E⟩")
    expect(asked).not.toContain("‮")
    // The list in ADE gets the command as asked: it is the one that is compared and answered.
    expect(detail).toContain("‮")
  })

  test("a question with nobody's answer after the turn ended is not answered", () => {
    const answers: string[] = []
    const ended = new AbortController()
    ended.abort()
    permissionAnswerer({
      ask: async () => "once",
      refuse: false,
      answer: (_id, reply) => void answers.push(reply),
      say: () => {},
      signal: ended.signal,
    })({
      permission: "bash",
      patterns: "rm -rf /",
      askedAt: 0,
    })
    expect(answers).toEqual([])
  })

  /* S17: a channel others read is asked nothing, and no command is written in it. */
  test("in a channel: no question, no command in the line, the line said once", () => {
    const answers: [string | undefined, string][] = []
    const said: string[] = []
    const asked: string[] = []
    const answerer = permissionAnswerer({
      ask: async (question) => void asked.push(question) as never,
      refuse: true,
      publicChat: true,
      answer: (id, reply) => void answers.push([id, reply]),
      say: (text) => void said.push(text),
      signal: new AbortController().signal,
    })
    answerer({ requestID: "r1", permission: "bash", patterns: "rm -rf build", askedAt: 0 })
    answerer({ requestID: "r2", permission: "bash", patterns: "rm -rf /", askedAt: 0 })
    answerer({ requestID: "r3", permission: "external_directory", patterns: "C:/x/*", askedAt: 0 })
    expect(answers).toEqual([["r1", "reject"], ["r2", "reject"], ["r3", "reject"]])
    expect(asked).toEqual([])
    expect(said).toEqual([t("gateway.approve.privateOnly")])
  })

  /* B8d review, M1: every answer names the question it is for. */
  test("an answer carries the id of its question: refused at once, or from the phone", async () => {
    const answers: [string | undefined, string][] = []
    const answerer = permissionAnswerer({
      ask: async () => "once",
      refuse: false,
      answer: (id, reply) => void answers.push([id, reply]),
      say: () => {},
      signal: new AbortController().signal,
    })
    answerer({ requestID: "per_blocco", permission: "bash", patterns: "rm -rf /", askedAt: 0 })
    answerer({ requestID: "per_telefono", permission: "bash", patterns: "git push --force", askedAt: 0 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(answers).toEqual([
      ["per_blocco", "reject"],
      ["per_telefono", "once"],
    ])
  })
})
