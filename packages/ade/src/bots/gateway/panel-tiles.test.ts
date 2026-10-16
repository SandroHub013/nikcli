import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { AgentFile } from "../ragu"
import {
  createGatewayPanel,
  type GatewayPanelApi,
  type GatewayStatus,
  type LinkStatus,
  type PairingInfo,
  type PairingRequest,
} from "./panel-state"
import { memoryRemoteStore } from "./remote"

/*
 * Scelta 2, the state under the tiles and the steps: what each platform shows, how many pairings wait on it,
 * the step the user is at, and where a failure belongs (D11).
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

function setup(
  statuses: GatewayStatus[],
  options: { waiting?: Record<string, number>; statusError?: string; failing?: Partial<Record<"setToken" | "probe" | "setEnabled" | "approve", string>> } = {},
) {
  const handlers: {
    status?: (status: LinkStatus) => void
    pairing?: (request: PairingRequest) => void
  } = {}
  const waiting = { ...options.waiting }
  const fail = (name: keyof NonNullable<typeof options.failing>) => {
    const message = options.failing?.[name]
    if (message) throw new Error(message)
  }
  const pairing = (platform: string): PairingInfo => ({
    open: true,
    pending: Array.from({ length: waiting[platform] ?? 0 }, (_, index) => ({
      bot: BOT.path,
      platform,
      request: `r${index}`,
      sender: { id: `${index}`, name: "x" },
      createdMs: 0,
      expiresMs: 1,
    })),
    authorized: [],
    attemptsLeft: 5,
  })
  const api: GatewayPanelApi = {
    status: async () => {
      if (options.statusError) throw new Error(options.statusError)
      return statuses
    },
    setToken: async () => fail("setToken"),
    clearToken: async () => {},
    probe: async () => {
      fail("probe")
      return "@mio_bot"
    },
    setEnabled: async () => fail("setEnabled"),
    pairingList: async (_bot, platform) => pairing(platform),
    pairingApprove: async () => {
      fail("approve")
      return { id: "1", name: "x" }
    },
    pairingReject: async () => {},
    pairingRevoke: async () => {},
    pairingOpen: async () => 1,
    listen: async (on) => {
      Object.assign(handlers, on)
      return () => {}
    },
  }
  const panel = createRoot(() =>
    createGatewayPanel({
      bot: () => BOT,
      api,
      project: () => "C:/progetto",
      remote: memoryRemoteStore(),
      approve: async () => ({ ok: true, fingerprint: "f" }),
      confirm: async () => true,
    }),
  )
  return { panel, handlers, waiting }
}

describe("what the tiles show", () => {
  test("each platform has its own state, and the pairings waiting are counted on the ones not looked at", async () => {
    const { panel } = setup(
      [
        link("telegram", { enabled: true, running: true, connected: true, hasToken: true }),
        link("discord", { enabled: true, running: false, hasToken: true }),
      ],
      { waiting: { telegram: 1, discord: 2, slack: 3 } },
    )
    await panel.refresh()
    expect(panel.tile("telegram")).toEqual({ state: "on", waiting: 1 })
    expect(panel.tile("discord")).toEqual({ state: "error", waiting: 2 })
    expect(panel.tile("slack")).toEqual({ state: "setup", waiting: 3 })
    panel.dispose()
  })

  test("a link that changes on a platform not shown changes its tile at once", async () => {
    const { panel, handlers } = setup([link("telegram", { enabled: true, running: true, connected: true, hasToken: true }), link("slack", { enabled: true, running: true, connected: false, hasToken: true })])
    await panel.refresh()
    await panel.ready
    expect(panel.tile("slack").state).toBe("connecting")
    handlers.status!({ bot: BOT.path, platform: "slack", running: true, connected: true })
    expect(panel.tile("slack").state).toBe("on")
    handlers.status!({ bot: BOT.path, platform: "slack", running: false, connected: false, lastError: "invalid_auth" })
    expect(panel.tile("slack").state).toBe("error")
    // Another bot's event is not this bot's tile.
    handlers.status!({ bot: "C:/altro.md", platform: "telegram", running: false, connected: false })
    expect(panel.tile("telegram").state).toBe("on")
    panel.dispose()
  })

  test("a request on another platform refreshes the badges", async () => {
    const { panel, handlers, waiting } = setup([link("telegram")], { waiting: {} })
    await panel.refresh()
    await panel.ready
    expect(panel.tile("discord").waiting).toBe(0)
    waiting.discord = 1
    handlers.pairing!({ bot: BOT.path, platform: "discord", request: "r0", sender: { id: "1", name: "x" }, createdMs: 0, expiresMs: 1 })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(panel.tile("discord").waiting).toBe(1)
    panel.dispose()
  })
})

describe("the step the user is at", () => {
  test("follows the link: create, then try, then pair", async () => {
    const fresh = setup([link("telegram")])
    await fresh.panel.refresh()
    expect(fresh.panel.at()).toBe("create")
    fresh.panel.dispose()

    const saved = setup([link("telegram", { hasToken: true })])
    await saved.panel.refresh()
    expect(saved.panel.at()).toBe("test")
    expect(saved.panel.steps().filter((step) => step.done).map((step) => step.id)).toEqual(["create", "paste"])
    saved.panel.dispose()

    const on = setup([link("telegram", { hasToken: true, enabled: true, running: true, connected: true })])
    await on.panel.refresh()
    expect(on.panel.at()).toBe("pair")
    on.panel.dispose()
  })

  test("Slack needs its second code before it is past the paste step", async () => {
    const { panel } = setup([link("slack", { hasToken: true })])
    panel.choose("slack")
    await panel.refresh()
    expect(panel.at()).toBe("paste")
    panel.dispose()
  })
})

describe("a failure belongs to the button that caused it (D11)", () => {
  test("a refused code is the paste step's, not the turning-on step's", async () => {
    const { panel } = setup([link("telegram")], { failing: { setToken: "Telegram ha rifiutato il codice" } })
    await panel.refresh()
    panel.setDraft("123456789:AA")
    await panel.saveToken()
    expect(panel.problemIn("paste")).toBe("Telegram ha rifiutato il codice")
    expect(panel.problemIn("on")).toBeUndefined()
    expect(panel.problemIn(undefined)).toBeUndefined()
    // The same text as before for whoever reads `problem()`.
    expect(panel.problem()).toBe("Telegram ha rifiutato il codice")
    panel.dispose()
  })

  test("each action puts its failure in its own place, and the next action clears it", async () => {
    const { panel } = setup([link("telegram", { hasToken: true })], { failing: { probe: "401", setEnabled: "no" } })
    await panel.refresh()
    await panel.probe()
    expect(panel.problemIn("test")).toBe("401")
    await panel.setEnabled(true)
    expect(panel.problemIn("on")).toBe("no")
    expect(panel.problemIn("test")).toBeUndefined()
    panel.dispose()
  })

  test("a failure of pairing is the pairing step's", async () => {
    const { panel } = setup([link("telegram", { hasToken: true })], { failing: { approve: "codice sbagliato" } })
    await panel.refresh()
    await panel.approve("AAAA")
    expect(panel.problemIn("pair")).toBe("codice sbagliato")
    panel.dispose()
  })

  test("a status that cannot be read belongs to no button", async () => {
    const { panel } = setup([link("telegram")], { statusError: "Rust non risponde" })
    await panel.refresh()
    expect(panel.problemIn(undefined)).toBe("Rust non risponde")
    expect(panel.problemIn("paste")).toBeUndefined()
    panel.dispose()
  })
})
