import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { codeOf } from "../test-support/source-text"
import { composerLogEntry, logWith, maskRow } from "./composer-log"
import {
  createDeliverNow,
  DELIVER_NOW_AFTER_MS,
  DELIVER_NOW_OVER_DIALOG_MS,
  turnKnown,
  type BlindHold,
} from "./deliver-now"
import { typeThenEnter } from "./enter"
import { STALE_BUSY_MS } from "./mailbox"
import { OUTPUT_CLAIM_MAX_MS } from "./output-activity"
import { Terminal } from "@xterm/xterm"
import { writtenTo } from "../test-support/live-bytes"

const BLIND: BlindHold = { blind: true }
const CLEAR: BlindHold = { blind: false }
const AFTER = DELIVER_NOW_AFTER_MS

type Now = ReturnType<typeof createDeliverNow>

/** The mail's rounds, one a second from `from` to `to`, each finding it held. What the last change was. */
function rounds(now: Now, from: number, to: number, hold: BlindHold = BLIND, sender?: string) {
  let change: ReturnType<Now["mailHeld"]>
  for (let at = from; at <= to; at += 1_000) change = now.mailHeld("p", hold, at, sender) ?? change
  return change
}

/** A pane whose box is not recognised, held for the whole wait. */
function offered() {
  const now = createDeliverNow()
  expect(rounds(now, 0, AFTER, BLIND, "sender")).toBe("offered")
  return now
}

describe("when it shows", () => {
  test("not before the 30 s", () => {
    const now = createDeliverNow()
    expect(rounds(now, 0, AFTER - 1_000)).toBeUndefined()
    expect(now.offered("p")).toBe(false)
  })

  test("never on a menu the reading sees, a trust dialog included, nor in a turn: `blind` is false there", () => {
    const now = createDeliverNow()
    expect(rounds(now, 0, AFTER * 10, CLEAR)).toBeUndefined()
    expect(now.offered("p")).toBe(false)
  })

  test("a menu for a moment starts the wait again", () => {
    const now = createDeliverNow()
    rounds(now, 0, 10_000)
    now.mailHeld("p", CLEAR, 11_000)
    expect(rounds(now, 12_000, 11_000 + AFTER - 1_000)).toBeUndefined()
    expect(now.mailHeld("p", BLIND, 11_000 + AFTER)).toBe("offered")
  })

  test("mail held once, long ago, does not count for the mail held now", () => {
    const now = createDeliverNow()
    rounds(now, 0, 20_000)
    expect(rounds(now, 80_000, 80_000 + AFTER - 1_000)).toBeUndefined()
    expect(now.mailHeld("p", BLIND, 80_000 + AFTER)).toBe("offered")
  })

  test("a line in the box that stands still counts, as a box not recognised does", () => {
    const now = createDeliverNow()
    expect(rounds(now, 0, AFTER, { blind: true, line: "2,5:❯ ciao" })).toBe("offered")
  })

  test("a line being written does not: each change of it starts the wait again", () => {
    const now = createDeliverNow()
    rounds(now, 0, 20_000, { blind: true, line: "a" })
    expect(rounds(now, 21_000, 21_000 + AFTER - 1_000, { blind: true, line: "ab" })).toBeUndefined()
    expect(now.mailHeld("p", { blind: true, line: "ab" }, 21_000 + AFTER)).toBe("offered")
  })

  test("once, with who to tell", () => {
    const now = offered()
    expect(now.mailHeld("p", BLIND, AFTER + 700)).toBeUndefined()
    expect(now.untold("p")).toEqual(["sender"])
    expect(now.untold("p")).toEqual([])
  })

  test("the sender hears once per message held: every line is a turn it pays for, and the user may be typing in bursts", () => {
    const now = createDeliverNow()
    const told: string[] = []
    let offers = 0
    let at = 0
    for (let burst = 0; burst < 10; burst++) {
      for (let second = 0; second < 40; second++, at += 1_000) {
        if (now.mailHeld("p", { blind: true, line: `riga ${burst}` }, at, "sender") !== "offered") continue
        offers++
        told.push(...now.untold("p"))
      }
    }
    expect(offers).toBeGreaterThan(1)
    expect(told).toEqual(["sender"])
  })

  test("nor when a click runs out, or a menu comes and goes", () => {
    const now = offered()
    expect(now.untold("p")).toEqual(["sender"])
    now.click("p", false, AFTER)
    rounds(now, AFTER + 1_000, AFTER + 9_000)
    now.lapsed(AFTER + 10_000)
    expect(now.mailHeld("p", BLIND, AFTER + 10_000)).toBe("offered")
    expect(now.untold("p")).toEqual([])
    now.mailHeld("p", CLEAR, AFTER + 11_000)
    rounds(now, AFTER + 12_000, AFTER + 12_000 + AFTER)
    expect(now.untold("p")).toEqual([])
  })

  test("another sender, or the next message after this one went, does hear", () => {
    const now = offered()
    now.untold("p")
    now.mailHeld("p", BLIND, AFTER + 1_000, "other")
    expect(now.untold("p")).toEqual(["other"])
    now.click("p", false, AFTER + 2_000)
    now.take("p", AFTER + 3_000)
    rounds(now, AFTER + 4_000, AFTER + 4_000 + AFTER, BLIND, "sender")
    expect(now.untold("p")).toEqual(["sender"])
  })
})

describe("where the cursor says a dialog the reading misses (re-review R4)", () => {
  const DIALOG: BlindHold = { blind: true, dialog: true }
  const FIVE_MINUTES = DELIVER_NOW_OVER_DIALOG_MS

  test("five minutes, and not 30 s: a click there would approve a plan or answer a question", () => {
    const now = createDeliverNow()
    expect(rounds(now, 0, FIVE_MINUTES - 1_000, DIALOG)).toBeUndefined()
    expect(now.offered("p")).toBe(false)
    expect(now.mailHeld("p", DIALOG, FIVE_MINUTES)).toBe("offered")
  })

  test("not never: a CLI that comes to hide its cursor at rest still has a way out", () => {
    expect(FIVE_MINUTES).toBe(5 * 60_000)
  })

  test("a dialog that opens under the action takes it away, and its five minutes run from then", () => {
    const now = offered()
    expect(now.review("p", DIALOG, AFTER + 100)).toBe("withdrawn")
    expect(rounds(now, AFTER + 1_000, AFTER + FIVE_MINUTES, DIALOG)).toBeUndefined()
    expect(now.mailHeld("p", DIALOG, AFTER + 1_000 + FIVE_MINUTES)).toBe("offered")
  })

  test("the same, when a round sees it first", () => {
    const now = offered()
    expect(now.mailHeld("p", DIALOG, AFTER + 1_000)).toBe("withdrawn")
    expect(now.offered("p")).toBe(false)
  })

  test("closed, the plain wait stands: the mail has been held all along", () => {
    const now = createDeliverNow()
    rounds(now, 0, AFTER + 10_000, DIALOG)
    expect(now.mailHeld("p", BLIND, AFTER + 11_000)).toBe("offered")
  })

  test("reopened, its five minutes start again", () => {
    const now = createDeliverNow()
    rounds(now, 0, FIVE_MINUTES - 2_000, DIALOG)
    rounds(now, FIVE_MINUTES - 1_000, FIVE_MINUTES - 1_000, CLEAR)
    expect(rounds(now, FIVE_MINUTES, FIVE_MINUTES + FIVE_MINUTES - 1_000, DIALOG)).toBeUndefined()
  })
})

describe("a turn going, for what ADE knows", () => {
  const NOW = 100 * 60_000

  test("the hook's word, where there is one", () => {
    const facts = { working: false, now: NOW }
    expect(turnKnown({ ...facts, activity: { state: "busy", at: NOW - 1_000 } })).toBe(true)
    expect(turnKnown({ ...facts, activity: { state: "idle", at: NOW - 1_000 } })).toBe(false)
    // A Stop that never came: past this, a busy is not believed anywhere else either.
    expect(turnKnown({ ...facts, activity: { state: "busy", at: NOW - STALE_BUSY_MS } })).toBe(false)
  })

  test("no hook: a line ADE saw go, for as long as a turn is believed", () => {
    const facts = { working: true, now: NOW }
    expect(turnKnown({ ...facts, workingSince: NOW - 1_000 })).toBe(true)
    expect(turnKnown({ ...facts, workingSince: NOW - OUTPUT_CLAIM_MAX_MS })).toBe(false)
    expect(turnKnown({ working: false, workingSince: NOW - 1_000, now: NOW })).toBe(false)
  })

  test("a pane still starting is `working` with no turn yet: its first task is what starts one", () => {
    expect(turnKnown({ working: true, now: NOW })).toBe(false)
  })
})

describe("when it goes", () => {
  test("the line in the box changed", () => {
    const now = createDeliverNow()
    rounds(now, 0, AFTER, { blind: true, line: "a" })
    expect(now.review("p", { blind: true, line: "ab" }, AFTER + 100)).toBe("withdrawn")
    expect(now.offered("p")).toBe(false)
  })

  test("a menu came, or the box did", () => {
    const now = offered()
    expect(now.review("p", CLEAR, AFTER + 100)).toBe("withdrawn")
  })

  test("the mail has gone: no round found it held", () => {
    const now = offered()
    expect(now.review("p", BLIND, AFTER + 1_000)).toBeUndefined()
    expect(now.review("p", BLIND, AFTER + 6_000)).toBe("withdrawn")
  })
})

describe("the click", () => {
  test("one click, one message, and the action goes: never by itself", () => {
    const now = offered()
    expect(now.armed("p", AFTER)).toBe(false)
    expect(now.take("p", AFTER)).toBe(false)
    expect(now.click("p", false, AFTER)).toBe(true)
    expect(now.offered("p")).toBe(false)
    expect(now.armed("p", AFTER + 1)).toBe(true)
    expect(now.take("p", AFTER + 1)).toBe(true)
    // The next message waits like any other.
    expect(now.armed("p", AFTER + 2)).toBe(false)
    expect(now.take("p", AFTER + 2)).toBe(false)
    expect(now.click("p", false, AFTER + 3)).toBe(false)
  })

  test("the next message waits its whole 30 s: the click said nothing about it", () => {
    const now = offered()
    now.click("p", false, AFTER)
    now.take("p", AFTER + 1_000)
    expect(rounds(now, AFTER + 2_000, AFTER + 2_000 + AFTER - 1_000)).toBeUndefined()
    expect(now.mailHeld("p", BLIND, AFTER + 2_000 + AFTER)).toBe("offered")
  })

  test("the line it lets through has its text and its Enter, and the one after it nothing", async () => {
    const now = offered()
    now.click("p", false, AFTER)
    const typed: string[] = []
    const line = (text: string, armed: boolean) =>
      typeThenEnter({
        text,
        write: (data) => void typed.push(data),
        wait: async () => {},
        alive: () => true,
        // The box is not there: only the click opens the gate, and the reading of menus sees none.
        permissionOpen: () => !armed,
      })
    expect(await line("uno", now.take("p", AFTER + 1))).toBe("sent")
    expect(await line("due", now.take("p", AFTER + 2))).toBe("not-typed")
    expect(typed).toEqual(["uno", "\r"])
  })

  test("a menu that came before the click takes it back", () => {
    const now = offered()
    expect(now.click("p", true, AFTER)).toBe(false)
    expect(now.offered("p")).toBe(false)
    expect(now.armed("p", AFTER)).toBe(false)
  })

  test("a click whose message did not go says nothing about the screen later", () => {
    const now = offered()
    now.click("p", false, AFTER)
    expect(now.take("p", AFTER + 10_000)).toBe(false)
  })

  test("and it is not lost in silence: said once, and the action comes back while the mail waits", () => {
    const now = offered()
    now.click("p", false, AFTER)
    expect(rounds(now, AFTER + 1_000, AFTER + 9_000)).toBeUndefined()
    expect(now.lapsed(AFTER + 9_000)).toEqual([])
    expect(now.lapsed(AFTER + 10_000)).toEqual(["p"])
    expect(now.lapsed(AFTER + 11_000)).toEqual([])
    expect(now.armed("p", AFTER + 10_000)).toBe(false)
    expect(now.mailHeld("p", BLIND, AFTER + 10_000)).toBe("offered")
  })

  test("a click spent by its message has nothing to say", () => {
    const now = offered()
    now.click("p", false, AFTER)
    now.take("p", AFTER + 1_000)
    expect(now.lapsed(AFTER + 20_000)).toEqual([])
  })

  test("a session that has gone takes it with it", () => {
    const now = offered()
    expect(now.forget("p")).toBe("withdrawn")
    expect(now.offeredPanes()).toEqual([])
  })

  const source = (path: string) => codeOf(readFileSync(new URL(path, import.meta.url), "utf8"))
  const workbench = source("../surface/workbench.tsx")
  const between = (from: string, to: string) => {
    const start = workbench.indexOf(from)
    expect(start).toBeGreaterThan(0)
    return workbench.slice(start, workbench.indexOf(to, start))
  }

  test("lint: only the pane's button clicks it", () => {
    const renderer = source("../surface/pane-renderer.tsx")
    expect(renderer).toContain("onClick:()=>deps.deliverNow(current().id)")
    expect(workbench.split("deliverNow.click(").length).toBe(2)
    const start = workbench.indexOf("constpressDeliverNow=")
    expect(start).toBeGreaterThan(0)
    expect(workbench.indexOf("deliverNow.click(")).toBeGreaterThan(start)
    expect(workbench.indexOf("deliverNow.click(")).toBeLessThan(start + 100)
    expect(workbench).toContain("deliverNow:pressDeliverNow")
  })

  test("lint: the byte that ticks does not count: Claude Code at rest writes every 20 s", () => {
    const body = between("constblindHold=", "constdeliverNowNote=")
    expect(body).toContain("turnKnown(")
    expect(body).not.toContain("lastOutputAt")
  })

  test("lint: the click goes to mail, and a reminder, a time note or a panel's reply neither spends it nor passes on it", () => {
    expect(between("consttypeLineNow=", "constESC=")).toContain("constarmed=mail&&paneId!==undefined&&deliverNow.take(")
    expect(workbench).toContain("mail&&deliverNow.armed(paneId,Date.now())")
    expect(workbench).toContain("typeLine(session,formatTimeNote(request,now,timeNote),{unlessBusy:true})")
    expect(workbench).toContain("typeLine(session,handled.reply,{unlessBusy:true})")
    expect(between("constfreeNow=", "constisHooked=")).toContain("if(mail&&deliverNow.armed(")
    // ADE's own notices wait among the held lines too, and are no message: they neither bring the action nor spend it.
    expect(workbench).toContain("heldLines.push({paneId:target.pane,text,notice:true})")
    expect(workbench).toContain("heldLines.push({paneId:item.inbox.from,text,told:true,notice:true})")
    expect(workbench).toContain("freeNow(host,item.paneId,!item.notice)")
    expect(workbench).toContain("{mail:!item.notice}")
    expect(workbench).toContain("if(!item.notice)noteMailHeld(item.paneId,item.inbox?.from)")
    // `told` says the sender has heard of a message, and it stays a message: an update, a late reply, a first task.
    expect(workbench).not.toContain("freeNow(host,item.paneId,!item.told)")
    expect(workbench).not.toContain("if(!item.told)noteMailHeld")
  })

  test("lint: the sender hears through `untold`, and the wait asks the cursor", () => {
    expect(between("constdeliverNowChanged=", "constnoteMailHeld=")).toContain("deliverNow.untold(paneId)")
    expect(between("constblindHold=", "constdeliverNowNote=")).toContain("cursorSaysDialog(")
  })

  test("lint: a first task held on a line in the box is said too, after the same wait", () => {
    expect(workbench).toContain('if(boxRead&&boxHolds&&!asked&&box!=="ready")noteMailHeld(paneId,request?.from)')
  })
})

describe("the local log has the shape and not the text", () => {
  // Built here so a key-shaped literal never sits in the repository.
  const KEY = ["sk", "ant", "api03", "abcDEF123456"].join("-")

  test("letters and digits masked, the glyphs whole", () => {
    expect(maskRow("❯ Try 12 ─── ┃ > à")).toBe("❯ xxx 00 ─── ┃ > x")
    expect(maskRow(KEY)).not.toContain("sk")
    expect(maskRow(KEY)).not.toContain("123")
  })

  test("what the terminal shows does not reach it", async () => {
    const terminal = new Terminal({ cols: 80, rows: 6, allowProposedApi: true })
    await writtenTo(terminal, `${"─".repeat(20)}\r\n❯ ${KEY}\r\n${"─".repeat(20)}`)
    const text = logWith(null, composerLogEntry(terminal, "agy", "offered", 5))
    expect(text).not.toContain(KEY)
    expect(text).not.toContain("api03")
    const [entry] = JSON.parse(text)
    expect(entry).toMatchObject({ agent: "agy", reason: "offered", cols: 80, rows: 6 })
    expect(entry.cursor).toEqual([terminal.buffer.active.cursorX, terminal.buffer.active.cursorY])
    expect(entry.shape[1][1].startsWith("❯ xx-xxx-xxx00-")).toBe(true)
    expect(entry.shape[0][1]).toBe("─".repeat(20))
  })

  test("a shape already there is not added twice", async () => {
    const terminal = new Terminal({ cols: 40, rows: 4, allowProposedApi: true })
    await writtenTo(terminal, "abc")
    const once = logWith(null, composerLogEntry(terminal, "agy", "offered", 1))
    const twice = logWith(once, composerLogEntry(terminal, "agy", "offered", 2))
    expect(JSON.parse(twice).length).toBe(1)
  })

  test("its size is bounded, and the oldest go first", async () => {
    const terminal = new Terminal({ cols: 200, rows: 60, allowProposedApi: true })
    let text: string | null = null
    for (let n = 0; n < 200; n++) {
      await writtenTo(
        terminal,
        `\x1b[2J\x1b[H${Array.from({ length: 60 }, (_, y) => "─".repeat(((n * 7 + y) % 120) + 1)).join("\r\n")}`,
      )
      text = logWith(text, composerLogEntry(terminal, "agy", "offered", n))
    }
    expect(text!.length).toBeLessThanOrEqual(64 * 1024)
    const entries = JSON.parse(text!)
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.length).toBeLessThanOrEqual(40)
    expect(entries[entries.length - 1].at).toBe(199)
  })

  test("a log gone bad starts again", async () => {
    const terminal = new Terminal({ cols: 40, rows: 4, allowProposedApi: true })
    expect(JSON.parse(logWith("not json", composerLogEntry(terminal, "agy", "offered", 1))).length).toBe(1)
  })
})
