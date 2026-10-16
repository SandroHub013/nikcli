import { describe, expect, test } from "bun:test"
import { computeGatewayBarStatus, createGatewayBarStore, type GatewayLinkSummary } from "./bar-status"
import type { GatewayStatus, LinkStatus, PairingRequest } from "./panel-state"
import type { GatewayMessage } from "./controller"

describe("computeGatewayBarStatus", () => {
  test("returns undefined when no link is enabled", () => {
    expect(computeGatewayBarStatus([])).toBeUndefined()
    expect(
      computeGatewayBarStatus([
        { bot: "b1", platform: "telegram", enabled: false, running: false, connected: false },
      ]),
    ).toBeUndefined()
  })

  test("returns green (on) when enabled and connected", () => {
    const res = computeGatewayBarStatus([
      { bot: "b1", platform: "telegram", enabled: true, running: true, connected: true },
    ])
    expect(res).toBeDefined()
    expect(res?.tone).toBe("on")
    expect(res?.bot).toBe("b1")
  })

  test("returns yellow (wait) when enabled and reconnecting or connecting", () => {
    const res = computeGatewayBarStatus([
      { bot: "b1", platform: "telegram", enabled: true, running: true, connected: false, reconnecting: true },
    ])
    expect(res).toBeDefined()
    expect(res?.tone).toBe("wait")
    expect(res?.bot).toBe("b1")
  })

  test("returns red (error) when enabled and requires attention", () => {
    const res = computeGatewayBarStatus([
      { bot: "b1", platform: "telegram", enabled: true, running: true, connected: false, needsAttention: true },
    ])
    expect(res).toBeDefined()
    expect(res?.tone).toBe("error")
    expect(res?.bot).toBe("b1")
  })

  test("attention takes priority over reconnecting and connected", () => {
    const res = computeGatewayBarStatus([
      { bot: "b1", platform: "telegram", enabled: true, running: true, connected: true },
      { bot: "b2", platform: "discord", enabled: true, running: false, connected: false, needsAttention: true },
    ])
    expect(res?.tone).toBe("error")
    expect(res?.bot).toBe("b2")
  })
})

describe("createGatewayBarStore", () => {
  test("reads initial status and updates reactively on live status events", async () => {
    let statusHandler: ((s: LinkStatus) => void) | undefined
    let unlistened = false
    const mockApi = {
      status: async () => [
        {
          bot: "b1",
          platform: "telegram",
          enabled: true,
          running: true,
          connected: true,
          hasToken: true,
          authorized: [],
        } as GatewayStatus,
      ],
      listen: async (handlers: {
        status: (s: LinkStatus) => void
        pairing: (p: PairingRequest) => void
        message: (m: GatewayMessage) => void
      }) => {
        statusHandler = handlers.status
        return () => {
          unlistened = true
        }
      },
    }

    const store = createGatewayBarStore(mockApi)
    await new Promise((r) => setTimeout(r, 10))

    expect(store.status()?.tone).toBe("on")

    // Event: connection lost, reconnecting
    statusHandler?.({
      bot: "b1",
      platform: "telegram",
      running: true,
      connected: false,
      reconnecting: true,
    })

    expect(store.status()?.tone).toBe("wait")

    store.dispose()
    expect(unlistened).toBe(true)
  })

  test("switching off a link clears the indicator and does not stay red", async () => {
    let statusHandler: ((s: LinkStatus) => void) | undefined
    const mockApi = {
      status: async () => [
        {
          bot: "b1",
          platform: "telegram",
          enabled: true,
          running: true,
          connected: true,
          hasToken: true,
          authorized: [],
        } as GatewayStatus,
      ],
      listen: async (handlers: {
        status: (s: LinkStatus) => void
        pairing: (p: PairingRequest) => void
        message: (m: GatewayMessage) => void
      }) => {
        statusHandler = handlers.status
        return () => {}
      },
    }

    const store = createGatewayBarStore(mockApi)
    await new Promise((r) => setTimeout(r, 10))
    expect(store.status()?.tone).toBe("on")

    // Event on switch off: stop() sends running: false, needsAttention: false, enabled: false
    statusHandler?.({
      bot: "b1",
      platform: "telegram",
      enabled: false,
      running: false,
      connected: false,
      needsAttention: false,
    })

    expect(store.status()).toBeUndefined()
    expect(store.hasActive()).toBe(false)
  })
})

describe("the shell draws the gateway bottom bar indicator (Point 4)", () => {
  test("lint: workbench renders gateway status button in footerActions with platforms link", async () => {
    const { readFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const workbench = readFileSync(join(import.meta.dir, "../../surface/workbench.tsx"), "utf8")
    expect(workbench).toContain('data-action="gateway-status"')
    expect(workbench).toContain('openWaitingBot(bar().bot, undefined, "platforms")')
    expect(workbench).toContain('<span data-slot="gateway-dot" aria-hidden="true" />')
  })

  test("lint: bots.css styles the gateway status button dots", async () => {
    const { readFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const css = readFileSync(join(import.meta.dir, "../bots.css"), "utf8")
    expect(css).toContain('[data-action="gateway-status"][data-tone="on"] [data-slot="gateway-dot"]')
    expect(css).toContain('[data-action="gateway-status"][data-tone="wait"] [data-slot="gateway-dot"]')
    expect(css).toContain('[data-action="gateway-status"][data-tone="error"] [data-slot="gateway-dot"]')
  })
})
