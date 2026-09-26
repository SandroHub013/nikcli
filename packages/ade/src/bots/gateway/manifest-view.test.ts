import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { it as itDict } from "../../i18n/it"
import { en as enDict } from "../../i18n/en"

/* G10, live: the manifest wrapped in the panel's font, and a JSON wrapped mid-key is hard to check before pasting. */

const css = readFileSync(join(import.meta.dir, "..", "bots.css"), "utf8")
const panel = readFileSync(join(import.meta.dir, "panel.tsx"), "utf8")

describe("the Slack manifest in the panel", () => {
  test("reads as code, one line per line", () => {
    expect(panel).toContain('data-role="manifest"')
    const rule = /\[data-component="bot-gateway"\] \[data-role="manifest"\]\s*\{([^}]*)\}/.exec(css)
    expect(rule).not.toBeNull()
    expect(rule![1]).toContain("font-family: var(--ade-mono)")
    expect(rule![1]).toContain("white-space: pre")
  })
})

/*
 * The bot hears a channel only through `app_mention`, and a group DM the same
 * way: the manifest has no `message.mpim` (G10 delta, BASSO). The panel says so.
 */
describe("the Slack panel's line on where the bot hears", () => {
  test("a group message wants the mention, as a channel does", () => {
    expect(itDict["gateway.panel.slackInvite"]).toContain("messaggi di gruppo")
    expect(enDict["gateway.panel.slackInvite"]).toContain("group messages")
  })
})
