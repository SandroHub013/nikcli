import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { t } from "../i18n"
import { stopAnswer } from "./stop"
import { ForeignSession } from "./store"

/* C4: Stop that does not reach the server says so. */

describe("the chat's Stop", () => {
  test("stopped on the server: nothing to say", async () => {
    const asked: string[] = []
    const problems: string[] = []
    await stopAnswer({ abort: async (id) => void asked.push(id) }, "ses_1", (message) => problems.push(message))
    expect(asked).toEqual(["ses_1"])
    expect(problems).toEqual([])
  })

  test("the request does not arrive: the chat says the answer goes on", async () => {
    const problems: string[] = []
    const failing = {
      abort: async () => {
        throw new TypeError("Failed to fetch")
      },
    }
    await stopAnswer(failing, "ses_1", (message) => problems.push(message))
    expect(problems).toEqual([t("chat.stop.failed")])
  })

  test("a session made outside the chat: the store's reason", async () => {
    const problems: string[] = []
    const foreign = {
      abort: async () => {
        throw new ForeignSession(t("chat.foreignSession"))
      },
    }
    await stopAnswer(foreign, "ses_1", (message) => problems.push(message))
    expect(problems).toEqual([t("chat.foreignSession")])
  })

  test("no session open: nothing asked", async () => {
    const asked: string[] = []
    await stopAnswer({ abort: async (id) => void asked.push(id) }, undefined, () => {})
    expect(asked).toEqual([])
  })

  test("lint: the view stops through stopAnswer and swallows no failure", () => {
    const view = readFileSync(new URL("./chat.tsx", import.meta.url), "utf8")
    expect(view).toMatch(/stopAnswer\(/)
    expect(view).not.toMatch(/\.catch\(\s*\(\)\s*=>\s*\{\s*\}\s*\)/)
  })
})
