import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { en } from "../i18n/en"
import { it as itDict } from "../i18n/it"

/*
 * B8b: the rooms' view. A `.tsx` cannot be imported under `bun test` here,
 * so what matters in it is read from the source: the logic is in `room.ts`
 * and `room-app.ts`, tested with fake bots.
 */

const panel = readFileSync(new URL("./room-panel.tsx", import.meta.url), "utf8")
const bots = readFileSync(new URL("./bots.tsx", import.meta.url), "utf8")

describe("B8b: the room in the Bot section", () => {
  test("a room is made only as `room.ts` allows: its size, and the spend (only free models in ADE Test)", () => {
    const create = bots.slice(bots.indexOf("  create: async (draft)"), bots.indexOf("  remove: async (roomId)"))
    expect(create).toContain("roomProblem(draft.members)")
    expect(create).toContain("roomSpendProblem(pays, draft.spend, isAdeTestBuild())")
  })

  test("each member is trusted as a turn in the panel is, with the panel's dialog, before the room runs", () => {
    const seats = bots.slice(bots.indexOf("  seats: async (room)"), bots.indexOf("  turns,\n  testBuild: isAdeTestBuild"))
    expect(seats).toContain("admitTurn(read, roomProject, askTrust)")
    expect(seats).toContain("pay: await payOf(bot)")
  })

  test("the member on turn's question is answered in the room, with the panel's three answers", () => {
    expect(panel).toContain('props.deps.answer(speaking()!, "reject")')
    expect(panel).toContain('props.deps.answer(speaking()!, "once")')
    expect(panel).toContain('props.deps.answer(speaking()!, "always")')
    expect(bots).toContain("permission: (roomId, path) => talkOf(roomThread(roomId, path)).permission")
    expect(bots).toContain("if (bot) turns.answer(bot, choice)")
  })

  test("«ti serve» shows in the list and in the room; «Ferma» stops the run", () => {
    expect(panel.match(/room\.needsYou|current\(\)\.needsYou/g)?.length).toBeGreaterThanOrEqual(2)
    expect(panel).toContain("props.deps.stop(current().id)")
    expect(bots).toContain("stop: (roomId) => void roomRunner.stop(roomId)")
  })

  test("how a run ended is drawn plain; only a problem is drawn as one (B8b review)", () => {
    expect(panel).toContain('data-slot={current().noteKind === "end" ? "room-note" : "bots-problem"}')
  })

  test("a room goes only on the user's yes, with its members' sessions", () => {
    const remove = bots.slice(bots.indexOf("  remove: async (roomId)"))
    expect(remove).toContain('askYesNo(t("bots.room.deleteAsk"')
    expect(remove).toContain("updateTalk(roomThread(roomId, path), () => emptyTalk())")
  })

  test("the room's words are in both languages", () => {
    const keys = [...panel.matchAll(/t\("(bots\.room\.[\w.]+)"/g)].map((match) => match[1]!)
    expect(keys.length).toBeGreaterThan(10)
    for (const key of keys) {
      expect(key in en).toBe(true)
      expect(key in itDict).toBe(true)
    }
  })
})
