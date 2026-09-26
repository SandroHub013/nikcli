import { describe, expect, test } from "bun:test"
import { t } from "../../i18n"
import { approveOnPhone, permissionAnswerer } from "./approval"

/*
 * B8d: the question on the phone is nikcli's own event, with the whole
 * command: nothing read off a terminal, nothing cut, so nothing to warn about.
 */
describe("the command shown on the phone", () => {
  test("the whole command, as nikcli asked about it, with no warning that it may be cut", async () => {
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

  test("a question with nobody's answer after the turn ended is not answered", () => {
    const answers: string[] = []
    const ended = new AbortController()
    ended.abort()
    permissionAnswerer({ ask: async () => "once", refuse: false, answer: (reply) => void answers.push(reply), say: () => {}, signal: ended.signal })({
      permission: "bash",
      patterns: "rm -rf /",
      askedAt: 0,
    })
    expect(answers).toEqual([])
  })
})
