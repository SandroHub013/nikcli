import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { codeOf } from "../test-support/source-text"
import { composerLogEntry, logWith, maskRow } from "./composer-log"
import { createDeliverNow, DELIVER_NOW_AFTER_MS } from "./deliver-now"
import { typeThenEnter } from "./enter"
import { Terminal } from "@xterm/xterm"
import { writtenTo } from "../test-support/live-bytes"

const STILL = { blind: true, lastOutputAt: 0 }

/** A pane whose box is not recognised, held for the whole wait, on a screen that has stopped. */
function offered() {
  const now = createDeliverNow()
  now.mailHeld("p", STILL, 0, "sender")
  expect(now.mailHeld("p", STILL, DELIVER_NOW_AFTER_MS, "sender")).toBe("offered")
  return now
}

describe("when it shows", () => {
  test("not before the 30 s", () => {
    const now = createDeliverNow()
    expect(now.mailHeld("p", STILL, 0)).toBeUndefined()
    expect(now.mailHeld("p", STILL, DELIVER_NOW_AFTER_MS - 1)).toBeUndefined()
    expect(now.offered("p")).toBe(false)
  })

  test("not on a screen that moves: a held mail counts from the last byte", () => {
    const now = createDeliverNow()
    now.mailHeld("p", { blind: true, lastOutputAt: 0 }, 0)
    expect(
      now.mailHeld("p", { blind: true, lastOutputAt: DELIVER_NOW_AFTER_MS - 1 }, DELIVER_NOW_AFTER_MS),
    ).toBeUndefined()
    expect(now.offered("p")).toBe(false)
  })

  test("never on a menu the reading sees, a trust dialog included: there the answer is the menu's", () => {
    const now = createDeliverNow()
    for (const at of [0, DELIVER_NOW_AFTER_MS, DELIVER_NOW_AFTER_MS * 10]) {
      expect(now.mailHeld("p", { blind: false, lastOutputAt: 0 }, at)).toBeUndefined()
    }
    expect(now.offered("p")).toBe(false)
  })

  test("a menu for a moment starts the wait again", () => {
    const now = createDeliverNow()
    now.mailHeld("p", STILL, 0)
    now.mailHeld("p", { blind: false, lastOutputAt: 0 }, 10_000)
    expect(now.mailHeld("p", STILL, DELIVER_NOW_AFTER_MS)).toBeUndefined()
    expect(now.mailHeld("p", STILL, 10_000 + DELIVER_NOW_AFTER_MS)).toBeUndefined()
    expect(now.mailHeld("p", STILL, DELIVER_NOW_AFTER_MS * 2)).toBe("offered")
  })

  test("once, with who to tell", () => {
    const now = offered()
    expect(now.mailHeld("p", STILL, DELIVER_NOW_AFTER_MS + 700)).toBeUndefined()
    expect(now.senders("p")).toEqual(["sender"])
  })
})

describe("when it goes", () => {
  test("the screen moved", () => {
    const now = offered()
    const moved = { blind: true, lastOutputAt: DELIVER_NOW_AFTER_MS + 100 }
    now.mailHeld("p", STILL, DELIVER_NOW_AFTER_MS + 100)
    expect(now.review("p", moved, DELIVER_NOW_AFTER_MS + 200)).toBe("withdrawn")
    expect(now.offered("p")).toBe(false)
  })

  test("a menu came, or the box did", () => {
    const now = offered()
    expect(now.review("p", { blind: false, lastOutputAt: 0 }, DELIVER_NOW_AFTER_MS + 100)).toBe("withdrawn")
  })

  test("the mail has gone: no round found it held", () => {
    const now = offered()
    expect(now.review("p", STILL, DELIVER_NOW_AFTER_MS + 1_000)).toBeUndefined()
    expect(now.review("p", STILL, DELIVER_NOW_AFTER_MS + 6_000)).toBe("withdrawn")
  })
})

describe("the click", () => {
  test("one click, one message, and the action goes: never by itself", () => {
    const now = offered()
    expect(now.armed("p", DELIVER_NOW_AFTER_MS)).toBe(false)
    expect(now.take("p", DELIVER_NOW_AFTER_MS)).toBe(false)
    expect(now.click("p", false, DELIVER_NOW_AFTER_MS)).toBe(true)
    expect(now.offered("p")).toBe(false)
    expect(now.armed("p", DELIVER_NOW_AFTER_MS + 1)).toBe(true)
    expect(now.take("p", DELIVER_NOW_AFTER_MS + 1)).toBe(true)
    // The next message waits like any other.
    expect(now.armed("p", DELIVER_NOW_AFTER_MS + 2)).toBe(false)
    expect(now.take("p", DELIVER_NOW_AFTER_MS + 2)).toBe(false)
    expect(now.click("p", false, DELIVER_NOW_AFTER_MS + 3)).toBe(false)
  })

  test("the line it lets through has its text and its Enter, and the one after it nothing", async () => {
    const now = offered()
    now.click("p", false, DELIVER_NOW_AFTER_MS)
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
    expect(await line("uno", now.take("p", DELIVER_NOW_AFTER_MS + 1))).toBe("sent")
    expect(await line("due", now.take("p", DELIVER_NOW_AFTER_MS + 2))).toBe("not-typed")
    expect(typed).toEqual(["uno", "\r"])
  })

  test("a menu that came before the click takes it back", () => {
    const now = offered()
    expect(now.click("p", true, DELIVER_NOW_AFTER_MS)).toBe(false)
    expect(now.offered("p")).toBe(false)
    expect(now.armed("p", DELIVER_NOW_AFTER_MS)).toBe(false)
  })

  test("a click whose message did not go says nothing about the screen later", () => {
    const now = offered()
    now.click("p", false, DELIVER_NOW_AFTER_MS)
    expect(now.take("p", DELIVER_NOW_AFTER_MS + 10_000)).toBe(false)
  })

  test("a session that has gone takes it with it", () => {
    const now = offered()
    expect(now.forget("p")).toBe("withdrawn")
    expect(now.offeredPanes()).toEqual([])
  })

  const source = (path: string) => codeOf(readFileSync(new URL(path, import.meta.url), "utf8"))

  test("lint: only the pane's button clicks it", () => {
    const renderer = source("../surface/pane-renderer.tsx")
    const workbench = source("../surface/workbench.tsx")
    expect(renderer).toContain("onClick:()=>deps.deliverNow(current().id)")
    expect(workbench.split("deliverNow.click(").length).toBe(2)
    const start = workbench.indexOf("constpressDeliverNow=")
    expect(start).toBeGreaterThan(0)
    expect(workbench.indexOf("deliverNow.click(")).toBeGreaterThan(start)
    expect(workbench.indexOf("deliverNow.click(")).toBeLessThan(start + 100)
    expect(workbench).toContain("deliverNow:pressDeliverNow")
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
