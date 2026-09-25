import { describe, expect, test } from "bun:test"
import { t } from "../../i18n"
import { approveOnPhone, shownCommand } from "./approval"

/*
 * G5 review, BASSO 2: the command on the phone is read from nikcli's menu in
 * the terminal, and can be cut. Whoever approves is told so, and a command
 * surely cut is marked.
 */
describe("the command shown on the phone", () => {
  test("a command cut at its first `)` is marked, a whole one is not", () => {
    // nikcli drew `bash (echo $(rm -rf build) && ls)`: the menu line stops at the first `)`.
    expect(shownCommand("echo $(rm -rf build")).toBe("echo $(rm -rf build …")
    expect(shownCommand("npm test")).toBe("npm test")
    expect(shownCommand("  ls -la  ")).toBe("ls -la")
    expect(shownCommand("")).toBe("?")
  })

  test("the question says the command may be incomplete, and to answer no if it is not recognized", async () => {
    let asked = ""
    const ask = async (question: string) => {
      asked = question
      return undefined
    }
    const permission = { permission: "bash", patterns: "echo $(rm -rf build", askedAt: 0 }
    const verdict = await approveOnPhone(permission, ask, new AbortController().signal)
    expect(asked).toBe(t("gateway.approve.question", "bash", "echo $(rm -rf build …"))
    expect(asked).toContain("No")
    expect(verdict).toEqual({ answer: "reject", expired: true })
    expect(t("gateway.approve.question", "bash", "x")).toMatch(/incomplet/)
  })
})
