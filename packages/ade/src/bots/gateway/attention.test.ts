import { describe, expect, test } from "bun:test"
import { createApprovalRegistry } from "../approvals"
import { syncGatewayAttention } from "./attention"
import type { GatewayStatus, LinkStatus, PairingRequest } from "./panel-state"
import type { GatewayMessage } from "./controller"

describe("syncGatewayAttention", () => {
  test("syncs initial statuses and live events into approval registry", async () => {
    const registry = createApprovalRegistry()
    let statusHandler: ((s: LinkStatus) => void) | undefined
    const mockApi = {
      status: async () => [
        {
          bot: "C:/bots/bot1.md",
          platform: "telegram",
          enabled: true,
          running: true,
          connected: false,
          needsAttention: true,
          attentionReason: "10 minuti senza risposta",
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

    const syncer = syncGatewayAttention({ approvals: registry, api: mockApi })
    await new Promise((r) => setTimeout(r, 10))

    expect(registry.listAttentions()).toHaveLength(1)
    expect(registry.listAttentions()[0]).toMatchObject({
      id: "gateway:C:/bots/bot1.md:telegram",
      bot: "C:/bots/bot1.md",
      botName: "bot1",
      platform: "telegram",
      reason: "10 minuti senza risposta",
    })

    // Status event clears attention
    statusHandler?.({
      bot: "C:/bots/bot1.md",
      platform: "telegram",
      running: true,
      connected: true,
      needsAttention: false,
    })

    expect(registry.listAttentions()).toHaveLength(0)

    // Status event sets attention on another platform
    statusHandler?.({
      bot: "C:/bots/bot1.md",
      platform: "discord",
      running: false,
      connected: false,
      needsAttention: true,
      attentionReason: "token revocato",
    })

    expect(registry.listAttentions()).toHaveLength(1)
    expect(registry.listAttentions()[0]!.platform).toBe("discord")

    syncer.stop()
  })

  test("uses custom botName resolver from roster instead of raw filename (P2-3)", async () => {
    const registry = createApprovalRegistry()
    const mockApi = {
      status: async () => [
        {
          bot: "C:/bots/revisore-pr.md",
          platform: "telegram",
          enabled: true,
          running: true,
          connected: false,
          needsAttention: true,
          attentionReason: "token non valido",
          hasToken: true,
          authorized: [],
        } as GatewayStatus,
      ],
      listen: async () => () => {},
    }

    const syncer = syncGatewayAttention({
      approvals: registry,
      api: mockApi,
      botName: (path) => (path.endsWith("revisore-pr.md") ? "Revisore dei PR" : path),
    })
    await new Promise((r) => setTimeout(r, 10))

    expect(registry.listAttentions()).toHaveLength(1)
    expect(registry.listAttentions()[0].botName).toBe("Revisore dei PR")
    syncer.stop()
  })
})
