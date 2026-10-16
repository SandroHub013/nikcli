/**
 * The gateway indicator in ADE's bottom bar (Point 4):
 * - only shown if a messaging app link is enabled;
 * - green dot when connected, yellow when reconnecting, red when needs attention;
 * - click navigates to the bot's Platforms tab.
 */

import { createSignal } from "solid-js"
import { t } from "../../i18n"
import type { GatewayPanelApi } from "./panel-state"

export type GatewayBarTone = "on" | "wait" | "error"

export interface GatewayBarStatus {
  readonly tone: GatewayBarTone
  readonly bot: string
  readonly label: string
}

export interface GatewayLinkSummary {
  readonly bot: string
  readonly platform: string
  readonly enabled: boolean
  readonly running: boolean
  readonly connected: boolean
  readonly reconnecting?: boolean
  readonly needsAttention?: boolean
}

/**
 * Computes what the bottom bar status indicator shows across all gateway links.
 * Returns undefined if no messaging app is on (enabled).
 */
export function computeGatewayBarStatus(
  links: readonly GatewayLinkSummary[],
): GatewayBarStatus | undefined {
  const active = links.filter((link) => link.enabled)
  if (active.length === 0) return undefined

  // 1. Red: needs attention or stopped with error
  const attention = active.find((link) => link.needsAttention || (link.enabled && !link.running))
  if (attention) {
    return {
      tone: "error",
      bot: attention.bot,
      label: t("gateway.bar.needsAttention"),
    }
  }

  // 2. Yellow: reconnecting or not yet connected
  const reconnecting = active.find((link) => link.reconnecting || !link.connected)
  if (reconnecting) {
    return {
      tone: "wait",
      bot: reconnecting.bot,
      label: t("gateway.bar.reconnecting"),
    }
  }

  // 3. Green: connected
  const connected = active[0]!
  return {
    tone: "on",
    bot: connected.bot,
    label: t("gateway.bar.connected"),
  }
}

export function createGatewayBarStore(api: Pick<GatewayPanelApi, "status" | "listen">) {
  const [links, setLinks] = createSignal<Readonly<Record<string, GatewayLinkSummary>>>({})

  const key = (bot: string, platform: string) => `${bot}:${platform}`

  void api
    .status()
    .then((all) => {
      const map: Record<string, GatewayLinkSummary> = {}
      for (const item of all) {
        map[key(item.bot, item.platform)] = item
      }
      setLinks(map)
    })
    .catch(() => {})

  let unlisten: (() => void) | undefined
  void api
    .listen({
      status: (status) => {
        setLinks((prev) => {
          const k = key(status.bot, status.platform)
          const existing = prev[k]
          if (!existing) {
            return {
              ...prev,
              [k]: {
                bot: status.bot,
                platform: status.platform,
                enabled: status.running || status.connected,
                running: status.running,
                connected: status.connected,
                reconnecting: status.reconnecting ?? false,
                needsAttention: status.needsAttention ?? false,
              },
            }
          }
          return {
            ...prev,
            [k]: {
              ...existing,
              running: status.running,
              connected: status.connected,
              reconnecting: status.reconnecting ?? false,
              needsAttention: status.needsAttention ?? false,
            },
          }
        })
      },
      pairing: () => {},
      message: () => {},
    })
    .then((stop) => {
      unlisten = stop
    })
    .catch(() => {})

  const refresh = () => {
    void api
      .status()
      .then((all) => {
        const map: Record<string, GatewayLinkSummary> = {}
        for (const item of all) {
          map[key(item.bot, item.platform)] = item
        }
        setLinks(map)
      })
      .catch(() => {})
  }

  const dispose = () => {
    unlisten?.()
  }

  const status = () => computeGatewayBarStatus(Object.values(links()))
  const hasActive = () => Object.values(links()).some((link) => link.enabled)

  return {
    status,
    hasActive,
    refresh,
    dispose,
  }
}
