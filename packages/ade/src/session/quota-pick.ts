/**
 * The quota rule for `spawn` (S9): which agent to start when the one asked for
 * has no quota left.
 *
 * The mailbox asks `pickProvider` (see `provider-pick.ts`) and never reads a
 * quota itself; this is the picker the workbench registers there. Plain data
 * in, plain data out, so the rule is tested without a host, a timer or
 * anybody's real quota file.
 *
 * The rule, in the order it is applied:
 *
 *   - A `--model` or a `--fork` never reaches here: the mailbox does not ask.
 *   - An agent whose quota is fine, or unknown ("n/d"), is started as asked.
 *     Rerouting on no evidence would move work off agy or nikcli only because
 *     ADE cannot see their quota — which says nothing about the quota itself.
 *   - An agent in Limite is replaced by another agent with a real reading and
 *     quota left, the one with the most. Agents that are "n/d" or in Limite
 *     are never picked as the replacement: Codex, spent until its window
 *     resets, is not chosen until it has reset.
 *   - When no replacement qualifies, the agent asked for is started anyway,
 *     and the receipt says its quota is spent: refusing the spawn would make
 *     the caller's work wait on ADE's guess about a reset.
 */

import {
  type ProviderQuota,
  type QuotaSnapshot,
  isQuotaUnavailable,
  normalizeProviderId,
  quotaForAgent,
  selectBestProvider,
} from "./quota"
import type { PickInput, PickResult } from "./provider-pick"

/**
 * The agents a spawn may be rerouted to, in the order ties are broken.
 *
 * Only agents whose quota ADE can actually read: a candidate that is "n/d" is
 * never chosen, so listing agy or nikcli here would change nothing but the
 * work done to discard them.
 */
export const REROUTE_CANDIDATES: readonly string[] = ["claude-code", "codex"]

function resetPhrase(countdown: string | undefined): string {
  if (!countdown) return ""
  return countdown.includes("/") ? ` fino al ${countdown}` : ` per altri ${countdown}`
}

export function pickByQuota(
  input: PickInput,
  snapshot: QuotaSnapshot | undefined,
  now: number,
  candidates: readonly string[] = REROUTE_CANDIDATES,
): PickResult {
  const asked = quotaForAgent(input.agent, snapshot, now)
  if (!asked || isQuotaUnavailable(asked) || !asked.isLimit) return { agent: input.agent }

  const spent = `quota ${asked.providerName} esaurita (finestra ${asked.bindingKey}${resetPhrase(asked.countdown)})`

  // Only candidates with a real reading and quota left reach the ranking.
  const usable: Record<string, ProviderQuota> = {}
  const agentOf = new Map<string, string>()
  for (const agent of candidates) {
    if (agent === input.agent) continue
    const view = quotaForAgent(agent, snapshot, now)
    if (!view || isQuotaUnavailable(view) || view.isLimit) continue
    const provider = snapshot?.providers[normalizeProviderId(agent)]
    if (!provider) continue
    usable[agent] = provider
    agentOf.set(agent, view.providerName)
  }

  const choice = selectBestProvider(Object.keys(usable), usable, now)
  // The ranking answers with the provider's id ("claude"); the spawn needs the agent's.
  const chosen = Object.keys(usable).find((agent) => usable[agent]!.id === choice.chosen)
  if (!chosen) {
    return { agent: input.agent, reason: `${spent} e nessun altro agente ha quota disponibile: avvio ${input.agent} come chiesto` }
  }
  const left = quotaForAgent(chosen, snapshot, now)
  const leftText = left && !isQuotaUnavailable(left) ? `, ${left.displayValue} rimasto` : ""
  return { agent: chosen, reason: `${spent}; scelto ${chosen} (${agentOf.get(chosen)}${leftText})` }
}
