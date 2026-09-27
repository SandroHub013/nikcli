import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { registerWrite, type RegisterWriteDeps } from "../session/register-write"
import { USAGE } from "../session/mailbox"
import { sheetAnswerEvent } from "./answer"
import { parseDesignLog, serializeDesignEvent } from "./log"
import { foldProposals, resolvedMessage } from "./state"

/*
 * notifiche-design: a Claude Code session publishes the one sheet as a
 * claude.ai page and gives its link in `url`. ADE opens it in the system
 * browser, and «Ho scelto sul foglio» answers: the choice is in the page's
 * database, and the line delivered to the session says where to read it.
 */
const NOW = new Date("2026-09-27T12:00:00.000Z")
const URL = "https://claude.ai/artifact/YW83dtNjxJFCTbExtd3zyp"

function file() {
  let text = ""
  const deps: RegisterWriteDeps = {
    read: async () => text,
    append: async (line) => {
      text += line
    },
    now: () => NOW,
    sender: "Opus",
    fromPane: "p-opus",
    agent: "claude-code",
  }
  return { deps, text: () => text }
}

const opened = (url: string) =>
  JSON.stringify({
    k: "DS1",
    title: "La barra",
    url,
    variants: [
      { name: "Sobria", description: "", preview: "" },
      { name: "Banco", description: "", preview: "" },
    ],
  })

describe("a proposal's sheet on claude.ai", () => {
  test("url is kept when it is a claude.ai page, and refused otherwise", async () => {
    const good = file()
    expect(await registerWrite(good.deps, { register: "design", op: "aperta", text: opened(URL) })).toStartWith(
      "ok: DS1",
    )
    const proposal = foldProposals(parseDesignLog(good.text()).events).proposals[0]!
    expect(proposal.url).toBe(URL)

    const bad = file()
    const reply = await registerWrite(bad.deps, {
      register: "design",
      op: "aperta",
      text: opened("https://example.com/foglio"),
    })
    expect(reply).toStartWith("errore:")
    expect(bad.text()).toBe("")
  })

  test("«Ho scelto sul foglio» answers, and the session is told to read the choice from the page", () => {
    const events = [
      ...parseDesignLog(
        serializeDesignEvent({ ...JSON.parse(opened(URL)), type: "aperta", at: NOW.toISOString(), by: "Opus" }),
      ).events,
      sheetAnswerEvent({ k: "DS1" }, "", NOW),
    ]
    const proposal = foldProposals(events).proposals[0]!
    expect(proposal.status).toBe("risposta")
    expect(resolvedMessage(proposal)).toContain(`scelta sul foglio ${URL}: leggila con ArtifactData read_db`)
  })

  test("lint: the card offers the page and the button, and the sheet opens it in the system browser", () => {
    const card = readFileSync(join(import.meta.dir, "design-card.tsx"), "utf8")
    expect(card).toContain('<div data-slot="design-url">')
    expect(card).toContain("onClick={() => props.onOpenUrl?.()}")
    expect(card).toContain("onClick={() => props.onSheetChosen?.()}")
    const sheet = readFileSync(join(import.meta.dir, "design-sheet.tsx"), "utf8")
    expect(sheet).toContain("onOpenUrl={() => void openExternally(proposal().url!)}")
  })

  test("ade-msg help tells a Claude Code session how to publish the sheet", () => {
    expect(USAGE).toContain("design, url: se sei una sessione Claude Code")
    expect(USAGE).toContain("ArtifactData read_db")
  })
})
