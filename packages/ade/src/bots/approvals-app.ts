/**
 * The app's one list of what waits for the user (`approvals.ts`): the bots' panel and the chats' gateway open their
 * entries here, and the badge on the Bot section, the bell and the top of the roster read it through a signal.
 */

import { createSignal } from "solid-js"
import { createApprovalRegistry, mergeApprovals, type GatewayAttentionItem, type WaitingApproval } from "./approvals"

const [writes, setWrites] = createSignal(0)

export const appApprovals = createApprovalRegistry(() => setWrites((n) => n + 1))

/** What waits for the user now, merged. Reactive. */
export function waitingApprovals(): WaitingApproval[] {
  writes()
  return mergeApprovals(appApprovals.list())
}

/** Gateways that need attention now. Reactive. */
export function waitingAttentions(): readonly GatewayAttentionItem[] {
  writes()
  return appApprovals.listAttentions()
}

