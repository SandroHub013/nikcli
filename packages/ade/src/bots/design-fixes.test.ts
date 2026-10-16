import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { en } from "../i18n/en"
import { it } from "../i18n/it"
import { COLORS, SHAPES } from "./avatar"

/*
 * The design corrections of the bot's screens: D6, D9, D22, D25, D26. Markup in `.tsx` cannot be imported here, so
 * what matters in it is read from the source; the behaviour of the confirmation is in `confirm.test.ts`.
 */
const read = (file: string) => readFileSync(join(import.meta.dir, file), "utf8")
const view = read("bots.tsx")
const routines = read("routine-panel.tsx")
const memory = read("memory-panel.tsx")
const gateway = read("gateway/panel.tsx")
const rooms = read("room-panel.tsx")

describe("D6 and D9: what is lost is said before it is lost", () => {
  test("lint: «Ricomincia da zero» asks first, with the number of messages", () => {
    const thread = view.slice(view.indexOf("function Thread"), view.indexOf("function Message"))
    expect(thread).toContain('label={t("bots.talk.fresh")}')
    expect(thread).toContain('question={t("bots.talk.freshQuestion", props.talk.messages.length)}')
    expect(thread).not.toMatch(/onClick=\{\(\) => props\.onForget\(\)\}/)
    expect(it["bots.talk.freshQuestion"]!.length).toBeGreaterThan(0)
  })

  test("the deletion says what goes with the bot, in both languages", () => {
    const say = (catalog: Record<string, unknown>) =>
      (catalog["bots.delete.questionProject"] as (a: string, b: string, c: number) => string)("revisore", "C:/p/.ragu/agent/revisore.md", 2)
    expect(say(it)).toContain("memoria")
    expect(say(it)).toContain("2 routine")
    expect(say(it)).toContain("abbinato")
    expect(say(it)).toContain("C:/p/.ragu/agent/revisore.md")
    expect(say(it)).toContain("nel progetto")
    expect(say(en)).toContain("memory")
    expect(say(en)).toContain("2 routines")
    expect(say(en)).toContain("paired")
    expect(say(en)).toContain("in the project")
  })

  test("a bot with no routines does not list them as something that goes; English has the genitive", () => {
    const say = (catalog: Record<string, unknown>, routines: number) =>
      (catalog["bots.delete.questionGlobal"] as (a: string, b: string, c: number) => string)("revisore", "f.md", routines)
    expect(say(it, 0)).not.toContain("routine")
    expect(say(it, 0)).toContain("la sua memoria, le conversazioni")
    expect(say(it, 1)).toContain("memoria, una routine, le conversazioni")
    expect(say(en, 0)).not.toContain("routine")
    expect(say(en, 0)).toContain("Its memory goes with it, the conversations")
    expect(say(en, 1)).toContain("one routine, the conversations")
    expect(say(en, 0)).toContain("messaging apps' bot codes")
  })
})

describe("D25: every irreversible action asks the same way", () => {
  test("lint: routines, memory, the bot's code, the accounts, the rooms and the bot itself use the one confirmation", () => {
    expect(routines).toContain("<ConfirmAction")
    expect(memory).toContain("<ConfirmAction")
    expect(gateway.match(/<ConfirmAction/g)?.length).toBe(3)
    expect(rooms).toContain("<ConfirmAction")
    expect(view.slice(view.indexOf("function SettingsTab"))).toContain("<ConfirmAction")
  })

  test("lint: none of them acts on the first press", () => {
    expect(routines).not.toContain("onClick={() => props.deps.remove(routine.id)}")
    expect(memory).not.toContain("onClick={() => drop(block, at())}")
    expect(gateway).not.toContain("onClick={() => void panel.clearToken()}")
    expect(gateway).not.toContain("onClick={() => void panel.revoke(")
    // P2-P4: a refusal shuts the account out for 24 hours, so it asks, and the server counts from the press.
    expect(gateway).not.toContain("onClick={() => void panel.reject(")
    const hub = readFileSync(join(import.meta.dir, "../../src-tauri/src/gateway/hub.rs"), "utf8")
    const reject = hub.slice(hub.indexOf("pub fn pairing_reject"), hub.indexOf("/* ── the panel"))
    expect(reject).toContain("link.pairing.reject_at(request, now)")
    expect(reject).toContain("self.env.now_ms()")
    expect(view.slice(view.indexOf("remove: async (roomId)"), view.indexOf("payOf,\n}"))).not.toContain("askYesNo")
  })

  test("each says what it is about, in both languages", () => {
    for (const catalog of [it, en] as Record<string, unknown>[]) {
      for (const key of [
        "bots.routine.removeQuestion",
        "bots.memory.removeQuestion",
        "gateway.panel.revokeQuestion",
        "gateway.panel.rejectQuestion",
        "bots.room.deleteAsk",
      ]) {
        const question = (catalog[key] as (a: string) => string)("QUESTO")
        expect(question, key).toContain("QUESTO")
      }
      expect(String(catalog["gateway.panel.clearTokenQuestion"]).length).toBeGreaterThan(20)
    }
  })
})

describe("D26: an empty place says what to press", () => {
  test("lint: the empty centre has a button to make the first bot, and a list to choose from when there are some", () => {
    const blank = view.slice(view.indexOf('data-slot="bots-blank"'))
    expect(blank).toContain('t("bots.blank.create")')
    expect(blank).toContain('t("bots.blank.createAnother")')
    expect(blank).toContain('data-slot="bots-blank-list"')
    expect(blank).toContain("open(bot)")
  })

  test("lint: the empty roster and the empty list of rooms have a button too", () => {
    expect(view).toContain('t("bots.roster.createFirst")')
    expect(rooms).toContain('t("bots.room.createFirst")')
    expect(rooms).toContain('t("bots.room.listEmpty")')
  })
})

describe("D22: the screen reader can follow", () => {
  test("lint: the conversation and the room are logs that announce what is added", () => {
    for (const source of [view.slice(view.indexOf("function Thread"), view.indexOf("function Message")), rooms]) {
      expect(source).toContain('role="log"')
      expect(source).toContain('aria-live="polite"')
    }
  })

  test("P2-P6: the log announces what is added, not every piece of a streaming answer, and holds while the turn works", () => {
    const thread = view.slice(view.indexOf("function Thread"), view.indexOf("function Message"))
    expect(thread).toContain('aria-relevant="additions"')
    expect(thread).not.toContain('aria-relevant="additions text"')
    expect(thread).toContain('aria-busy={props.talk.status === "working"}')
    // A question waiting for the user is not «working»: it is announced.
    expect(rooms).toContain('aria-relevant="additions"')
    expect(rooms).not.toContain('aria-relevant="additions text"')
    expect(rooms).toContain("aria-busy={speaking() !== undefined && !asked()}")
  })

  test("lint: the message field, the routine's kind and the memory's fields have a name", () => {
    expect(view).toContain('aria-label={t("bots.composer.label", props.bot.identifier)}')
    expect(rooms).toContain('aria-label={t("bots.room.composerLabel", current().name)}')
    expect(routines).toContain('aria-label={t("bots.routine.kind.label")}')
    expect(memory).toContain('aria-label={t("bots.memory.fieldLabel"')
  })

  test("lint: the sections have a title for the screen reader to jump to", () => {
    expect(routines).toContain('<h3 data-slot="bots-section-title"')
    expect(memory).toContain('<h3 data-slot="bots-section-title"')
    expect(gateway).toContain('<h3 data-slot="bots-section-title"')
    expect(view.slice(view.indexOf("function SettingsTab")).match(/<h3 data-slot="bots-section-title"/g)?.length).toBe(3)
  })

  test("the shapes and colours of the face are named in words, in both languages, not by their ids", () => {
    for (const id of SHAPES) {
      expect(`bots.face.shape.${id}` in it, id).toBe(true)
      expect(`bots.face.shape.${id}` in en, id).toBe(true)
    }
    for (const id of COLORS) {
      expect(`bots.face.color.${id}` in it, id).toBe(true)
      expect(`bots.face.color.${id}` in en, id).toBe(true)
    }
    expect(it["bots.face.shape.tri"]).toBe("triangolo")
    expect(view).not.toContain("title={shape}")
    expect(view).not.toContain("title={color}")
  })
})
