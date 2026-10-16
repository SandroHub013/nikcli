import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Locale } from "../../i18n"
import { startMenuSync, type MenuDeps, type MenuLink } from "./menu"
import { chatCommand, chatMenu, type ChatCommand, type MenuEntry } from "./policy"

/* The menu of commands on Telegram: policy.ts's commands in ADE's language, once the gateway is up. */

describe("the menu is made from the commands the chat takes", () => {
  const ALL: ChatCommand[] = ["new", "stop", "status", "retry", "cost", "model", "sessions", "help"]

  test("every command is there in each language, under a name the chat understands, in words Telegram takes", () => {
    for (const language of ["it", "en"] as const) {
      const menu = chatMenu(language)
      expect(menu.map((entry) => chatCommand(`/${entry.command}`))).toEqual(ALL)
      for (const entry of menu) {
        expect(entry.command).toMatch(/^[a-z0-9_]{1,32}$/)
        expect(entry.description.length).toBeGreaterThan(0)
        expect(entry.description.length).toBeLessThanOrEqual(256)
      }
    }
  })

  test("the names and the words follow the language", () => {
    expect(chatMenu("it").map((entry) => entry.command)).toEqual([
      "nuova",
      "ferma",
      "stato",
      "riprova",
      "costo",
      "modello",
      "sessioni",
      "aiuto",
    ])
    expect(chatMenu("en").map((entry) => entry.command)).toEqual(["new", "stop", "status", "retry", "cost", "model", "sessions", "help"])
    expect(chatMenu("it")[0]!.description).toBe("Ricomincia la conversazione")
    expect(chatMenu("en")[0]!.description).toBe("Start the conversation over")
  })

  test("lint: Slack's manifest lists the same commands the menu does, in Italian", () => {
    const slack = readFileSync(join(import.meta.dir, "..", "..", "..", "src-tauri", "src", "gateway", "slack.rs"), "utf8")
    for (const entry of chatMenu("it").filter((each) => each.command !== "aiuto")) expect(slack).toContain(`"/${entry.command}"`)
    expect(slack).toContain('"/aiuto"')
  })
})

describe("the menu is put on the bot when its gateway is up", () => {
  const link = (over: Partial<MenuLink> = {}): MenuLink => ({
    bot: "/p/.nikcli/agent/aiuto.md",
    platform: "telegram",
    running: true,
    connected: true,
    ...over,
  })

  function harness(initial: readonly MenuLink[] = [], language: Locale = "it") {
    let handler: ((link: MenuLink) => void) | undefined
    let changed: (() => void) | undefined
    let now = language
    const sets: { bot: string; platform: string; commands: readonly MenuEntry[] }[] = []
    const warned: string[] = []
    const state = { fail: false, stopped: [] as string[] }
    const deps: MenuDeps = {
      statuses: async () => initial,
      onStatus: async (on) => {
        handler = on
        return () => void state.stopped.push("status")
      },
      set: async (bot, platform, commands) => {
        sets.push({ bot, platform, commands })
        if (state.fail) throw new Error("Telegram: BOT_COMMAND_INVALID")
      },
      language: () => now,
      watchLanguage: (on) => {
        changed = on
        return () => void state.stopped.push("language")
      },
      warn: (line) => void warned.push(line),
    }
    return {
      deps,
      sets,
      warned,
      state,
      emit: (next: MenuLink) => handler?.(next),
      speak: (next: Locale) => {
        now = next
        changed?.()
      },
    }
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

  test("a gateway already up when ADE starts gets its menu, in ADE's language, and no other platform does", async () => {
    const h = harness([link(), link({ platform: "discord" }), link({ bot: "/p/altro.md", connected: false })])
    await startMenuSync(h.deps)
    await settle()
    expect(h.sets).toHaveLength(1)
    expect(h.sets[0]).toEqual({ bot: "/p/.nikcli/agent/aiuto.md", platform: "telegram", commands: chatMenu("it") })
  })

  test("it waits for the gateway to be reading, and puts the menu once however many times it hears of it", async () => {
    const h = harness()
    await startMenuSync(h.deps)
    h.emit(link({ running: true, connected: false }))
    await settle()
    expect(h.sets).toHaveLength(0)
    h.emit(link())
    h.emit(link({ lastMessageMs: 5 } as Partial<MenuLink>))
    h.emit(link())
    await settle()
    expect(h.sets).toHaveLength(1)
  })

  test("a gateway switched off and on again is a new adapter: the menu goes again", async () => {
    const h = harness([link()])
    await startMenuSync(h.deps)
    await settle()
    h.emit(link({ running: false, connected: false }))
    await settle()
    expect(h.sets).toHaveLength(1)
    h.emit(link())
    await settle()
    expect(h.sets).toHaveLength(2)
  })

  test("the language changing puts the list again, in the new words, on every gateway that is up", async () => {
    const h = harness([link(), link({ bot: "/p/altro.md" }), link({ bot: "/p/spento.md", running: false, connected: false })])
    await startMenuSync(h.deps)
    await settle()
    expect(h.sets).toHaveLength(2)
    h.speak("en")
    await settle()
    expect(h.sets).toHaveLength(4)
    expect(h.sets.slice(2).map((each) => each.commands)).toEqual([chatMenu("en"), chatMenu("en")])
    // Said again in the same language: nothing new.
    h.speak("en")
    await settle()
    expect(h.sets).toHaveLength(4)
  })

  test("a menu Telegram refuses is noted once, not at every message, and tried again when the list changes", async () => {
    const h = harness([link()])
    h.state.fail = true
    await startMenuSync(h.deps)
    await settle()
    h.emit(link())
    h.emit(link())
    await settle()
    expect(h.sets).toHaveLength(1)
    expect(h.warned).toHaveLength(1)
    expect(h.warned[0]).toContain("BOT_COMMAND_INVALID")
    h.state.fail = false
    h.speak("en")
    await settle()
    expect(h.sets).toHaveLength(2)
  })

  test("stopping stops listening to both", async () => {
    const h = harness()
    const stop = await startMenuSync(h.deps)
    stop()
    expect(h.state.stopped.sort()).toEqual(["language", "status"])
    h.emit(link())
    await settle()
    expect(h.sets).toHaveLength(0)
  })
})

describe("in the app", () => {
  const bridge = readFileSync(join(import.meta.dir, "bridge.ts"), "utf8")

  test("lint: the menu is kept from the gateways' status and the language, and stops with the controller", () => {
    expect(bridge).toContain('invoke<void>("gateway_set_commands"')
    expect(bridge).toContain('listen<LiveStatus>("gateway:status"')
    expect(bridge).toContain("stopMenus()")
  })
})
