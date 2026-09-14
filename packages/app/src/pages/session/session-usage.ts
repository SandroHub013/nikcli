/**
 * What a session has cost so far.
 *
 * Every assistant message already carries its token breakdown and its price, and
 * nothing in the app ever showed either. Two of the four agent panels on the
 * market put this on screen — Zed next to the model selector, Copilot in the
 * session log — because the number that matters is the running one, not the
 * monthly total in a dashboard.
 */

export type UsageMessage = {
  role: string
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
}

export type SessionUsage = {
  /** What was actually charged for: input, output and reasoning. */
  billable: number
  input: number
  output: number
  reasoning: number
  /** Cache reads are near-free and would otherwise dwarf the real number. */
  cacheRead: number
  cacheWrite: number
  cost: number
  /** How many assistant turns contributed, so an empty session reads as empty. */
  turns: number
}

const EMPTY: SessionUsage = {
  billable: 0,
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 0,
}

export function sessionUsage(messages: readonly UsageMessage[]): SessionUsage {
  const total = { ...EMPTY }
  for (const message of messages) {
    if (message.role !== "assistant") continue
    const tokens = message.tokens
    // A turn that is still streaming reports nothing yet, and counting it would
    // show `0 · $0.00` for as long as it runs — which reads as the model having
    // produced nothing.
    //
    // Checking `!tokens` was useless: the server creates the assistant message
    // with a fully zeroed `tokens` object and the field is required on the
    // schema, so it is always present. Emptiness has to be read from the numbers.
    const counted = (tokens?.input ?? 0) + (tokens?.output ?? 0) + (tokens?.reasoning ?? 0)
    if (counted === 0 && !message.cost) continue
    total.turns += 1
    total.input += tokens?.input ?? 0
    total.output += tokens?.output ?? 0
    total.reasoning += tokens?.reasoning ?? 0
    total.cacheRead += tokens?.cache?.read ?? 0
    total.cacheWrite += tokens?.cache?.write ?? 0
    total.cost += message.cost ?? 0
  }
  total.billable = total.input + total.output + total.reasoning
  return total
}

/**
 * A count that fits beside a model name.
 *
 * Rounded down, never up: a session that has used 999 tokens has not used "1k",
 * and the number is read as a running total where overstating is the wrong error.
 */
export function formatTokens(count: number): string {
  if (count < 1000) return String(Math.max(0, Math.trunc(count)))
  if (count < 1_000_000) {
    const thousands = Math.trunc(count / 100) / 10
    return `${thousands % 1 === 0 ? thousands.toFixed(0) : thousands.toFixed(1)}k`
  }
  const millions = Math.trunc(count / 100_000) / 10
  return `${millions % 1 === 0 ? millions.toFixed(0) : millions.toFixed(1)}M`
}

/** Price, at the precision the number deserves. */
export function formatCost(cost: number, locale: string): string {
  const fractionDigits = cost > 0 && cost < 0.01 ? 4 : 2
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(cost)
}
