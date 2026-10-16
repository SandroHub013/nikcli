/**
 * The Platforms tab's rules (scelta 2): three tiles, one per platform, each with
 * its state; opening one starts a procedure in five steps with the point you are
 * at: create the bot, paste its code, try it, turn it on, pair your account.
 *
 * No view here, so the rules can be tested: which state a tile shows, which steps
 * are done, and which one the user is at.
 */

export const PLATFORM_IDS = ["telegram", "discord", "slack"] as const
export type PlatformId = (typeof PLATFORM_IDS)[number]

/** The states a tile shows (D30): turned on, connecting, still to connect, or in error. */
export type TileState = "on" | "connecting" | "setup" | "error"

/** What a tile needs of one link's status. */
export interface TileInput {
  readonly enabled: boolean
  readonly running: boolean
  readonly connected: boolean
  readonly lastError?: string | null
  readonly needsAttention?: boolean
}

export function tileState(link: TileInput | undefined): TileState {
  if (!link || !link.enabled) return "setup"
  if (!link.running || link.lastError || link.needsAttention) return "error"
  return link.connected ? "on" : "connecting"
}

export const STEP_IDS = ["create", "paste", "test", "on", "pair"] as const
export type StepId = (typeof STEP_IDS)[number]

export interface StepsInput {
  readonly hasToken: boolean
  /** Slack's second code is saved, or the platform has none (the caller says which). */
  readonly tokensReady: boolean
  /** The code was tried in this session, or the link is on (a link that is on has been tried by the only way there is). */
  readonly probed: boolean
  readonly enabled: boolean
  readonly authorized: number
}

export interface Step {
  readonly id: StepId
  readonly done: boolean
}

/**
 * The five steps and which are done. The first cannot be seen from outside: the bot exists when its code has been
 * pasted, so «create» is done when there is a code.
 */
export function stepsOf(input: StepsInput): readonly Step[] {
  const done: Record<StepId, boolean> = {
    create: input.hasToken,
    paste: input.tokensReady,
    test: input.probed || input.enabled,
    on: input.enabled,
    pair: input.authorized > 0,
  }
  return STEP_IDS.map((id) => ({ id, done: done[id] }))
}

/** The step the user is at: the first not done; the last when all are. */
export function currentStep(steps: readonly Step[]): StepId {
  return steps.find((step) => !step.done)?.id ?? "pair"
}

/** Where each platform's bot is made: a link the first step shows. */
export const CREATE_LINK: Record<PlatformId, string> = {
  telegram: "https://t.me/BotFather",
  discord: "https://discord.com/developers/applications",
  slack: "https://api.slack.com/apps",
}

/** The only places a step's link may lead; a test pins it. */
export const ALLOWED_LINKS: readonly string[] = Object.values(CREATE_LINK)
