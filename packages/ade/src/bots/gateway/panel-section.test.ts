import { afterEach, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { compileSolidJsx } from "../../test-support/solid-jsx"
import type { AgentFile } from "../ragu"
import type { GatewayPanelApi, GatewayStatus, PairingInfo, PairingRequest } from "./panel-state"
import { memoryRemoteStore } from "./remote"
import { forgetTurnFailures } from "./failures"

if (typeof document === "undefined") GlobalRegistrator.register()
compileSolidJsx()

const { createComponent, render } = await import("solid-js/web")
const { GatewaySection } = await import("./panel")
const { setLocalePreference } = await import("../../i18n")

setLocalePreference("it")

/*
 * Scelta 2: the Platforms tab, rendered with a fake Rust side. Three tiles with
 * their state and the pairings waiting; opening one starts the five steps, with
 * the instructions before the field, the failure by the button that caused it, and
 * the place of the QR left empty (scelta 3 comes later).
 */

const BOT: AgentFile = {
  identifier: "aiuto",
  path: "C:/Users/me/agent/aiuto.md",
  scope: "global",
  description: "",
  mode: "primary",
  prompt: "",
  disabledTools: [],
  runner: "ragu",
}

const link = (platform: string, patch: Partial<GatewayStatus> = {}): GatewayStatus => ({
  bot: BOT.path,
  platform,
  enabled: false,
  running: false,
  connected: false,
  hasToken: false,
  authorized: [],
  ...patch,
})

function fake(statuses: GatewayStatus[], pending: Record<string, number> = {}, failToken = false) {
  const opened: string[] = []
  const pairing = (platform: string): PairingInfo => ({
    open: true,
    pending: Array.from({ length: pending[platform] ?? 0 }, (_, index) => ({
      bot: BOT.path,
      platform,
      request: `r${index}`,
      sender: { id: `${index}`, name: "Ale" },
      createdMs: 0,
      expiresMs: Date.now() + 60_000,
    })) as PairingRequest[],
    authorized: [],
    attemptsLeft: 5,
  })
  const api: GatewayPanelApi = {
    status: async () => statuses,
    setToken: async () => {
      if (failToken) throw new Error("Telegram ha rifiutato il codice")
    },
    clearToken: async () => {},
    probe: async () => "@mio_bot",
    setEnabled: async () => {},
    pairingList: async (_bot, platform) => pairing(platform),
    pairingApprove: async () => ({ id: "1", name: "Ale" }),
    pairingReject: async () => {},
    pairingRevoke: async () => {},
    pairingOpen: async () => 1,
    listen: async () => () => {},
  }
  return { api, opened }
}

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
  forgetTurnFailures()
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

async function mount(statuses: GatewayStatus[], options: { pending?: Record<string, number>; failToken?: boolean } = {}) {
  const host = document.createElement("div")
  document.body.append(host)
  const { api, opened } = fake(statuses, options.pending, options.failToken)
  dispose = render(
    () =>
      createComponent(GatewaySection, {
        bot: BOT,
        deps: {
          api,
          project: () => "C:/progetto",
          remote: memoryRemoteStore(),
          approve: async () => ({ ok: true as const, fingerprint: "f" }),
          confirm: async () => true,
          openLink: (url: string) => void opened.push(url),
        },
      }),
    host,
  )
  await settle()
  const tile = (id: string) => [...document.querySelectorAll('[data-slot="gateway-tile"]')].find((el) => el.textContent?.includes(id))!
  const press = async (el: Element | undefined | null) => {
    ;(el as HTMLElement).click()
    await settle()
  }
  const step = (id: string) => document.querySelector(`[data-slot="gateway-step"][data-step="${id}"]`)!
  return { opened, tile, press, step }
}

describe("the three tiles", () => {
  test("are Telegram, Discord and Slack, each with its own state", async () => {
    const { tile } = await mount([
      link("telegram", { enabled: true, running: true, connected: true, hasToken: true }),
      link("discord", { enabled: true, running: false, hasToken: true }),
    ])
    const tiles = document.querySelectorAll('[data-slot="gateway-tile"]')
    expect(tiles.length).toBe(3)
    expect(tile("Telegram").getAttribute("data-state")).toBe("on")
    expect(tile("Discord").getAttribute("data-state")).toBe("error")
    expect(tile("Slack").getAttribute("data-state")).toBe("setup")
    expect(tile("Telegram").textContent).toContain("Acceso")
    expect(tile("Discord").textContent).toContain("Errore")
    expect(tile("Slack").textContent).toContain("Da collegare")
  })

  test("a badge counts the pairings waiting, on the tile that has them", async () => {
    const { tile } = await mount([link("telegram"), link("discord"), link("slack")], { pending: { discord: 2, slack: 1 } })
    expect(tile("Discord").querySelector('[data-slot="gateway-badge"]')?.textContent).toBe("2 in attesa")
    expect(tile("Slack").querySelector('[data-slot="gateway-badge"]')?.textContent).toBe("1 in attesa")
    expect(tile("Telegram").querySelector('[data-slot="gateway-badge"]')).toBeNull()
    expect(tile("Discord").getAttribute("aria-label")).toBe("Discord: Da collegare, 2 in attesa")
  })

  test("nothing is open until the user chooses, unless a platform is already on", async () => {
    await mount([link("telegram")])
    expect(document.querySelector('[data-slot="gateway-steps"]')).toBeNull()
    expect(document.body.textContent).toContain("Scegli dove vuoi scrivere a questo bot")
    dispose?.()
    document.body.innerHTML = ""
    await mount([link("telegram", { enabled: true, running: true, connected: true, hasToken: true })])
    expect(document.querySelector('[data-slot="gateway-steps"]')).not.toBeNull()
  })
})

describe("opening a tile starts the five steps", () => {
  test("they are in the order create, paste, try, turn on, pair, and the user is at the first", async () => {
    const { tile, press, step } = await mount([link("telegram")])
    await press(tile("Telegram"))
    const ids = [...document.querySelectorAll('[data-slot="gateway-step"]')].map((el) => el.getAttribute("data-step"))
    expect(ids).toEqual(["create", "paste", "test", "on", "pair"])
    expect(step("create").getAttribute("data-state")).toBe("here")
    expect(step("create").textContent).toContain("sei qui")
    expect(step("paste").getAttribute("data-state")).toBe("todo")
  })

  test("step one gives the link to BotFather and names what to do", async () => {
    const { tile, press, opened } = await mount([link("telegram")])
    await press(tile("Telegram"))
    expect(document.body.textContent).toContain("BotFather")
    await press([...document.querySelectorAll("button")].find((b) => b.textContent === "Apri BotFather"))
    expect(opened).toEqual(["https://t.me/BotFather"])
  })

  test("Discord's and Slack's first step send to their own place", async () => {
    const discord = await mount([link("discord")])
    await discord.press(discord.tile("Discord"))
    await discord.press([...document.querySelectorAll("button")].find((b) => b.textContent === "Apri il portale"))
    expect(discord.opened).toEqual(["https://discord.com/developers/applications"])
    dispose?.()
    document.body.innerHTML = ""
    const slack = await mount([link("slack")])
    await slack.press(slack.tile("Slack"))
    await slack.press([...document.querySelectorAll("button")].find((b) => b.textContent === "Apri Slack API"))
    expect(slack.opened).toEqual(["https://api.slack.com/apps"])
  })

  test("«avanti» goes to the second step, where the instructions come before the field (D3)", async () => {
    const { tile, press, step } = await mount([link("telegram")])
    await press(tile("Telegram"))
    await press([...document.querySelectorAll("button")].find((b) => b.textContent === "Ho creato il bot: avanti"))
    const body = step("paste").querySelector('[data-slot="gateway-step-body"]')!
    const hint = body.querySelector('[data-slot="bots-hint"]')!
    const field = body.querySelector("input")!
    expect(hint.textContent).toContain("BotFather")
    // The hint precedes the field in the document.
    const order = [...body.querySelectorAll("*")]
    expect(order.indexOf(hint)).toBeGreaterThan(-1)
    expect(order.indexOf(hint)).toBeLessThan(order.indexOf(field))
  })

  test("a saved code makes steps one and two done and puts the user at the trial", async () => {
    const { tile, press, step } = await mount([link("telegram", { hasToken: true })])
    await press(tile("Telegram"))
    expect(step("create").getAttribute("data-state")).toBe("done")
    expect(step("paste").getAttribute("data-state")).toBe("done")
    expect(step("test").getAttribute("data-state")).toBe("here")
    expect(step("test").textContent).toContain("Prova")
  })

  test("a failure shows by the button that caused it, not at the foot of the section (D11)", async () => {
    const { tile, press, step } = await mount([link("telegram")], { failToken: true })
    await press(tile("Telegram"))
    await press([...document.querySelectorAll("button")].find((b) => b.textContent === "Ho creato il bot: avanti"))
    const input = step("paste").querySelector("input")!
    input.value = "123456789:AAfinto"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    await settle()
    step("paste").querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    await settle()
    const problems = document.querySelectorAll('[data-slot="bots-problem"]')
    expect(problems.length).toBe(1)
    expect(step("paste").contains(problems[0]!)).toBe(true)
    expect(problems[0]!.textContent).toBe("Telegram ha rifiutato il codice")
  })

  test("the pairing step keeps today's code form, and leaves the place of the QR empty without a text or a button", async () => {
    // Already on, so already open: a press on its tile would close it.
    const { press, step } = await mount([link("telegram", { hasToken: true, enabled: true, running: true })], {
      pending: { telegram: 1 },
    })
    await press(step("pair").querySelector('[data-slot="gateway-step-head"]'))
    const body = step("pair").querySelector('[data-slot="gateway-step-body"]')!
    expect(body.querySelector("form[data-secrets] input")).not.toBeNull()
    const slot = body.querySelector('[data-slot="gateway-pair-link"]')!
    expect(slot).not.toBeNull()
    expect(slot.childNodes.length).toBe(0)
    expect(slot.textContent).toBe("")
  })
})
