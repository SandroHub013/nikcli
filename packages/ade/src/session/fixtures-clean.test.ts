import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { loadCapture } from "../test-support/live-bytes"

/*
 * The captures are real bytes from a real machine, and this repository is published. What the agents printed there was
 * the user's: their agy rules, the team's folders, their plan and quota (review B6). So this list says what no capture
 * may carry, on the raw bytes and with the escapes taken out, for whichever capture is added next.
 */
const PRIVATE =
  /unsandboxed|wezterm|herdr|win32_|powercfg|antigravity-cli|favorites|ade-team|tmp-prova|team\.md|ade-msg-help|nikcli-ade|lavoro-\d|\.ade-test|claude max|google ai|cache-keeper|5h \d|wk \d|sub \d|197610|39349/i
const ESCAPES = /\x1b\[[0-9;?>]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[=>()][0-9A-Za-z]?|\x1b./g

describe("the captures keep nothing of the user's", () => {
  const names = readdirSync(new URL("./fixtures/live", import.meta.url)).map((file) => file.replace(".json.gz", ""))

  test("there are captures to look at", () => {
    expect(names.length).toBeGreaterThan(0)
  })

  for (const name of names) {
    test(name, () => {
      const raw = loadCapture(name)
        .chunks.map(([, chunk]) => chunk)
        .join("")
      expect(raw.match(PRIVATE)?.[0]).toBeUndefined()
      expect(raw.replace(ESCAPES, "").match(PRIVATE)?.[0]).toBeUndefined()
    })
  }
})
