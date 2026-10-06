import { afterAll, describe, expect, mock, test } from "bun:test"
import { resetLocaleForTests } from "../i18n/locale"

/*
 * A launch the host refuses (`pty_spawn`) names the reason. For the keys an
 * agent was given, the reason comes from `secrets.rs` as a code
 * (`key.keychain.refused`, `key.envReserved:PATH`); the pane must show the
 * sentence in the interface's language, never the code (review of F7b, O1).
 */

const realCore = await import("@tauri-apps/api/core")
const realEvent = await import("@tauri-apps/api/event")

let refusal = "key.keychain.refused"

mock.module("@tauri-apps/api/core", () => ({
  ...realCore,
  invoke: async (cmd: string) => {
    if (cmd === "pty_spawn") throw refusal
    return undefined
  },
}))
mock.module("@tauri-apps/api/event", () => ({
  ...realEvent,
  listen: async () => () => {},
}))

afterAll(() => {
  mock.module("@tauri-apps/api/core", () => realCore)
  mock.module("@tauri-apps/api/event", () => realEvent)
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  resetLocaleForTests("it")
})

;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
const { getHost } = await import("./shell")

async function launch(onRefused?: (reason: string) => void) {
  const host = await getHost()
  const lines: Array<[string, string]> = []
  await host!.spawn({
    command: "claude",
    args: [],
    cwd: "C:/p",
    onData: () => {},
    onLine: (line: string, stream: string) => lines.push([line, stream]),
    onExit: () => {},
    ...(onRefused ? { onRefused } : {}),
  } as never)
  return lines
}

describe("a refused launch, in the interface's language (F7b, O1)", () => {
  test("the pane's refusal is the sentence, not the host's code", async () => {
    resetLocaleForTests("en")
    refusal = "key.keychain.refused"
    const reasons: string[] = []
    await launch(reason => reasons.push(reason))
    expect(reasons).toEqual(["the system keychain refused the operation"])
    refusal = "key.envReserved:PATH"
    reasons.length = 0
    await launch(reason => reasons.push(reason))
    expect(reasons).toEqual(["PATH is reserved"])
  })

  test("without a refusal handler the sentence goes to the pane as an error line", async () => {
    resetLocaleForTests("it")
    refusal = "key.keychain.noAccess"
    const lines = await launch()
    expect(lines).toEqual([["portachiavi di sistema non accessibile", "err"]])
  })

  test("a refusal that is not a code is shown as it came", async () => {
    resetLocaleForTests("en")
    refusal = "«foo» non è installato"
    const reasons: string[] = []
    await launch(reason => reasons.push(reason))
    expect(reasons).toEqual(["«foo» non è installato"])
  })
})
