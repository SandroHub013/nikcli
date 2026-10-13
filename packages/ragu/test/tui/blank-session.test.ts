import { describe, expect, test } from "bun:test"
import { showsHome } from "@tui/routes/session/blank"

/*
 * ADE starts ragu on a conversation it has just created (`--session <id>`), so
 * the user never saw the home: only an empty session view. A root conversation
 * with nothing in it shows the home instead, until its first message.
 */

const empty = { loaded: true, root: true, messages: 0, pending: 0, started: false }

describe("showsHome", () => {
  test("a root conversation, loaded and empty, shows the home", () => {
    expect(showsHome(empty)).toBe(true)
  })

  test("not before its messages are known: a conversation with history must not flash the home", () => {
    expect(showsHome({ ...empty, loaded: false })).toBe(false)
  })

  test("the first message, even still pending, leaves the home", () => {
    expect(showsHome({ ...empty, messages: 1 })).toBe(false)
    expect(showsHome({ ...empty, pending: 1 })).toBe(false)
  })

  test("a subagent's conversation never shows it", () => {
    expect(showsHome({ ...empty, root: false })).toBe(false)
  })

  test("once a conversation has started it does not come back, even if its messages go", () => {
    expect(showsHome({ ...empty, started: true })).toBe(false)
  })
})
