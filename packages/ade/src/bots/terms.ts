/**
 * What the providers' terms ask of ADE when it runs their CLIs (S13).
 *
 * ADE starts the official Claude Code and Codex CLIs the user installed and
 * signed in to, with that user's own plan. The terms that allow it
 * (`ade-team/results/master-D7-termini.md`) set the conditions kept here:
 *
 * - credentials stay with the CLIs: ADE never reads or carries them (a test
 *   holds the source to that);
 * - a turn starts from something the user did, and only a few run at once;
 * - when a plan's limit is reached the turn ends there, and ADE never retries
 *   or switches account to get around it;
 * - the user is told, where bots are set up, whose account pays and on which terms.
 */

import { t } from "../i18n"

/** Runners that spend the user's Anthropic or ChatGPT plan, rather than keys the user gave nikcli. */
export const PLAN_RUNNERS: readonly string[] = ["claude", "codex"]

/** How many turns on one plan may run at the same time. */
export const MAX_PARALLEL_TURNS = 3

const running = new Map<string, number>()

/**
 * A place for one more turn on `runnerId`'s plan, or why there is none.
 *
 * The release function gives the place back; calling it twice does nothing.
 * Runners not on a plan always get one.
 */
export function acquireTurn(runnerId: string, label = runnerId): { release: () => void } | { problem: string } {
  if (!PLAN_RUNNERS.includes(runnerId)) return { release: () => {} }
  const now = running.get(runnerId) ?? 0
  if (now >= MAX_PARALLEL_TURNS) {
    return {
      problem: t("bots.terms.parallel", now, label, MAX_PARALLEL_TURNS),
    }
  }
  running.set(runnerId, now + 1)
  let released = false
  return {
    release: () => {
      if (released) return
      released = true
      running.set(runnerId, Math.max(0, (running.get(runnerId) ?? 1) - 1))
    },
  }
}

/** Turns on `runnerId`'s plan running now. */
export function turnsRunning(runnerId: string): number {
  return running.get(runnerId) ?? 0
}

const LIMIT =
  /usage limit|rate limit|limit reached|hit your limit|limit will reset|quota exceeded|out of (?:extra )?usage|too many requests|\b429\b/i

/** Whether a CLI's error says the plan's limit was reached. */
export function limitReached(text: string): boolean {
  return LIMIT.test(text)
}

export function limitNotice(label: string): string {
  return t("bots.limit.notice", label)
}

/** What an obvious API key becomes once a thread is about to be stored (B4). */
export const SECRET_MARK = "[nascosto]"

/**
 * Keys a tool's printout, a bot's reply or a CLI's last line can carry in
 * the clear. A command such as `env` prints them; ADE does not have the
 * values, so these shapes are what it can recognise. Long enough that
 * ordinary words are left alone.
 */
const SECRET =
  /sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xai-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|\d{8,10}:[A-Za-z0-9_-]{35}|Bearer\s+[A-Za-z0-9\-._~+/=]{20,}/g

/** Takes those keys out of text that would otherwise be written with the thread. */
export function scrubSecrets(text: string): string {
  return text.replace(SECRET, SECRET_MARK)
}

/**
 * Which routines may run (B11). One row per runner and mode.
 *
 * The scheduler, the daily counters and the "ADE was closed" rule are not
 * here. `routinePolicy` is what that scheduler must ask before a run, and
 * `routineConsentHash` is what suspends a routine when the account changes.
 */

export type RoutineMode = "plan" | "key" | "free" | "paid"

export interface RoutineCap {
  readonly perDay?: number
  readonly minGapMin?: number
  readonly perRunUsd?: number
  readonly perDayUsd?: number
  readonly spendCapRequired?: boolean
}

export interface RoutineRow {
  readonly runner: string
  readonly mode: RoutineMode
  readonly allowed: boolean
  readonly cap?: RoutineCap
  readonly source?: string
  readonly checked?: string
  readonly reason?: string
}

const OPENROUTER = "https://openrouter.ai/docs/api-reference/limits"
const CHECKED_TERMS = "2026-09-15"
const CHECKED_OPENROUTER = "2026-09-25"

export const ROUTINE_POLICY: readonly RoutineRow[] = [
  {
    runner: "nikcli",
    mode: "free",
    allowed: true,
    cap: { perDay: 20, minGapMin: 15 },
    source: OPENROUTER,
    checked: CHECKED_OPENROUTER,
  },
  {
    runner: "nikcli",
    mode: "paid",
    allowed: true,
    cap: { perRunUsd: 0.1, perDayUsd: 0.5, spendCapRequired: true },
    source: OPENROUTER,
    checked: CHECKED_OPENROUTER,
  },
  {
    runner: "claude",
    mode: "key",
    allowed: true,
    cap: { perRunUsd: 0.1, perDayUsd: 0.5, spendCapRequired: true },
    source: "https://www.anthropic.com/legal/consumer-terms",
    checked: CHECKED_TERMS,
  },
  {
    runner: "claude",
    mode: "plan",
    allowed: true,
    cap: { perDay: 8, minGapMin: 60 },
    source: "https://code.claude.com/docs/en/authentication",
    checked: CHECKED_TERMS,
  },
  {
    runner: "codex",
    mode: "key",
    allowed: false,
    reason: "Codex non riporta un costo, quindi il tetto di spesa non si può controllare",
    source: "https://learn.chatgpt.com/docs/auth",
    checked: "2026-09-25",
  },
  {
    runner: "codex",
    mode: "plan",
    allowed: true,
    cap: { perDay: 8, minGapMin: 60 },
    source: "https://learn.chatgpt.com/docs/non-interactive-mode",
    checked: CHECKED_TERMS,
  },
  {
    runner: "grok",
    mode: "plan",
    allowed: false,
    reason: "i termini xAI non sono stati letti",
    checked: CHECKED_TERMS,
  },
]

/** nikcli's mode is the catalog model (`:free`), never the name the user typed. */
export function routineModeOf(
  runner: string | undefined,
  accountMode: "plan" | "key" | undefined,
  model: string | undefined,
  /** The catalog's word (`catalog.ts`); absent, the `:free` suffix. */
  free?: boolean,
): RoutineMode {
  if (!runner || runner === "nikcli") return (free ?? (typeof model === "string" && /:free$/i.test(model.trim()))) ? "free" : "paid"
  return accountMode === "key" ? "key" : "plan"
}

export function routinePolicy(
  runner: string,
  mode: RoutineMode,
  model?: string | undefined,
  free?: boolean,
): { readonly allowed: true; readonly cap: RoutineCap } | { readonly allowed: false; readonly reason: string } {
  if (runner === "grok") return { allowed: false, reason: "i termini xAI non sono stati letti" }
  const effective: RoutineMode = runner === "nikcli" ? routineModeOf(runner, undefined, model, free) : mode
  const row = ROUTINE_POLICY.find((entry) => entry.runner === runner && entry.mode === effective)
  if (!row || !row.allowed || !row.cap) {
    return { allowed: false, reason: row?.reason ?? "questo runner non può eseguire routine" }
  }
  return { allowed: true, cap: row.cap }
}

/**
 * Prompt, runner, mode, model, cap and the key's name hashed with SHA-256 via crypto.subtle.
 * A change in any of these fields invalidates the stored consent.
 */
export async function routineConsentHash(input: {
  readonly prompt: string
  readonly runner: string
  readonly mode: string
  readonly model: string
  readonly cap: string
  readonly key?: string | undefined
}): Promise<string> {
  const payload = [input.prompt, input.runner, input.mode, input.model, input.cap, input.key ?? ""].join("\u001f")
  const buffer = new TextEncoder().encode(payload)
  const digest = await crypto.subtle.digest("SHA-256", buffer)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * True only when the stored consent matches the current hash and is a valid SHA-256 digest.
 * A consent stored with the legacy (pre-SHA-256) format is rejected and must be granted again.
 */
export function routineConsentHolds(saved: string, now: string): boolean {
  return /^[0-9a-f]{64}$/i.test(saved) && saved === now
}
