/**
 * Keeps track of gateway links that require user attention and syncs them into
 * the approvals registry (`approvals.ts`), so they appear in the bell and flash
 * the window when ADE is behind.
 */

import { t } from "../../i18n"
import type { ApprovalRegistry } from "../approvals"
import type { GatewayPanelApi, LinkStatus } from "./panel-state"

export interface GatewayAttentionSyncDeps {
  readonly approvals: Pick<ApprovalRegistry, "openAttention" | "closeAttention">
  readonly api: Pick<GatewayPanelApi, "status" | "listen">
  readonly botName?: (botPath: string) => string
}

/** The reason Rust gives for a link that needs attention, said in ADE's language; any other is shown as it is. */
export const QUEUE_FULL_REASON = "coda_piena"

export function attentionText(reason: string | null | undefined): string | undefined {
  if (reason === "timeout_10m") return t("gateway.panel.attentionTimeout")
  if (reason === QUEUE_FULL_REASON) return t("gateway.panel.attentionQueueFull")
  return reason ?? undefined
}

export function syncGatewayAttention(deps: GatewayAttentionSyncDeps): { stop: () => void } {
  let stopped = false
  let unlisten: (() => void) | undefined

  const deriveBotName = deps.botName ?? ((path: string) => path.split(/[/\\]/).pop()?.replace(/\.md$/, "") ?? path)

  const handleStatus = (status: Pick<LinkStatus, "bot" | "platform" | "needsAttention" | "attentionReason">) => {
    const key = `gateway:${status.bot}:${status.platform}`
    if (status.needsAttention) {
      const reason = attentionText(status.attentionReason)
      deps.approvals.openAttention({
        id: key,
        bot: status.bot,
        botName: deriveBotName(status.bot),
        platform: status.platform,
        reason,
        at: Date.now(),
      })
    } else {
      deps.approvals.closeAttention(key)
    }
  }

  // Initial read
  void deps.api
    .status()
    .then((all) => {
      if (stopped) return
      for (const item of all) {
        handleStatus(item)
      }
    })
    .catch(() => {})

  // Listen for live updates
  void deps.api
    .listen({
      status: (status) => {
        if (!stopped) handleStatus(status)
      },
      pairing: () => {},
      message: () => {},
    })
    .then((stop) => {
      if (stopped) stop()
      else unlisten = stop
    })
    .catch(() => {})

  return {
    stop: () => {
      stopped = true
      unlisten?.()
    },
  }
}
