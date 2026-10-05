/**
 * MAI in front of the local voice.
 *
 * One speaker, the same contract as the one underneath. An Italian reply on a
 * MAI voice goes to MAI; everything else goes straight to the local speaker,
 * which already knows how to fall from Piper to the system voice. When MAI
 * cannot answer, the rest of the reply — and only the rest — goes there too,
 * and the user hears why exactly once per outage.
 *
 * The cloud is never warmed up. `prepare` is how a local voice loads its model
 * before the first reply, and asking MAI for it would be a sentence the user
 * pays for and never hears.
 */

import type { Speaker } from "./speaker"
import { cleanForSpeech } from "./clean"
import { splitSentences } from "./natural-speaker"
import { isMaiVoice, maiVoice, type MaiVoiceId } from "../settings/reply-voices"
import { dayOf, type SpendTally } from "../settings/spend"
import {
  createMaiBreaker,
  maiCapReached,
  MaiError,
  reserveMai,
  speakMai,
  type MaiClientDeps,
  type MaiFailureKind,
} from "./mai"

export interface MaiSpeakerDeps {
  /** The voice the reply is read in, already resolved for its language. */
  voiceFor: (text: string) => { voice: string; locale: string }
  /** Whether a key is present right now. Read per reply: one removed mid-reply is gone. */
  hasKey: () => boolean
  client: MaiClientDeps
  /** What reads whatever MAI does not. */
  local: Speaker
  /**
   * Plays one WAV and resolves when it ends. When `signal` aborts — «annulla»,
   * or the next reply starting — the sound stops and the promise resolves.
   */
  play: (wav: ArrayBuffer, signal: AbortSignal) => Promise<void>
  /**
   * Said once when MAI gives up, before the local voice takes the rest.
   * `payment` is the one with its own sentence, because it is the one the user
   * can fix by adding credit.
   */
  notice: (kind: MaiFailureKind, keyWasPresent: boolean) => string | undefined
  /** A sentence was spoken, with what it was reserved at. */
  onSpoken?: (info: { generationId?: string; reservedUsd: number; chars: number }) => void
  /**
   * The day's spending, shared with listening: the tally the workbench made
   * once. Without it nothing is reserved and no cap applies (the tests that are
   * not about money).
   */
  spend?: {
    tally: SpendTally
    /** What a generation really cost, or undefined; see `settleMai`. */
    settle?: (generationId: string) => Promise<number | undefined>
  }
  /** Why MAI is not being asked right now, or undefined when it is: for the panel's state and «Riprova». */
  onState?: (blocked: MaiFailureKind | undefined) => void
}

/** The kinds only «Riprova» reopens, for the panel: a cooldown or a new day does nothing for these. */
export const MAI_MANUAL_KINDS: readonly MaiFailureKind[] = ["payment", "unauthorized", "bad-request"]

/**
 * Kinds where the service answered and refused: nothing was synthesised, so the
 * reservation is given back. A timeout, an abort or audio in the wrong format
 * may still be billed, and keep it.
 */
const REFUNDED: ReadonlySet<MaiFailureKind> = new Set([
  "payment",
  "unauthorized",
  "forbidden",
  "unavailable",
  "rate-limited",
  "bad-request",
])

export interface MaiSpeaker extends Speaker {
  /** Opens the breaker whatever closed it. The panel's «Riprova». */
  retry(): void
  /** Whether MAI would be asked for this voice right now. */
  available(): boolean
}

/**
 * What the user is told, or nothing.
 *
 * No key at all is the ordinary state of a profile that has not added one yet,
 * and it is read locally without a word. A key that disappears between one
 * sentence and the next is not ordinary: the reply started on the cloud voice
 * and finished on another, and that is worth saying. So is a bill that cannot
 * be paid.
 */
export function maiFallbackNotice(kind: MaiFailureKind, keyWasPresent: boolean): string | undefined {
  if (kind === "payment") return "Credito OpenRouter esaurito: uso la voce locale."
  if (kind === "cap") return "Tetto di spesa della voce raggiunto: uso la voce locale."
  if (kind === "no-key") return keyWasPresent ? "Manca la chiave OpenRouter: uso la voce locale." : undefined
  return "La voce cloud non è disponibile: uso la voce locale."
}

export function createMaiSpeaker(deps: MaiSpeakerDeps): MaiSpeaker {
  const breaker = createMaiBreaker()
  let generation = 0
  let notified = false
  /*
   * One per reply. «Annulla» and the next reply both abort it, and with it the
   * request in flight — which would otherwise go on for up to fifteen seconds
   * and be paid for — and the sentence that is playing.
   */
  let reply: AbortController | undefined
  /** The day the cap was last said on: once a day, not once per reply. */
  let capToldOn: string | undefined
  let refunds = 0
  const now = () => deps.client.now?.() ?? Date.now()
  const report = () => deps.onState?.(breaker.blocked(now())?.kind)

  function maiVoiceOf(voice: string): MaiVoiceId | undefined {
    if (!isMaiVoice(voice as MaiVoiceId)) return undefined
    return maiVoice(voice as MaiVoiceId)?.id
  }

  async function sayLocal(mine: number, text: string, kind: MaiFailureKind, keyWasPresent: boolean): Promise<void> {
    if (!notified) {
      notified = true
      const line = deps.notice(kind, keyWasPresent)
      if (line) await deps.local.speak(line)
      // «Annulla» while the notice was being said stops the notice; the rest of
      // a reply that was cancelled is not read afterwards as if nothing happened.
      if (mine !== generation) return
    }
    if (text.trim().length > 0) await deps.local.speak(text)
  }

  return {
    async speak(text: string): Promise<void> {
      try {
        await speakReply(text)
      } finally {
        report()
      }
    },

    cancel(): void {
      generation++
      reply?.abort()
      reply = undefined
      deps.local.cancel()
    },

    prefetch(text: string): void {
      const { voice } = deps.voiceFor(text)
      if (maiVoiceOf(voice)) return
      deps.local.prefetch?.(text)
    },

    retry(): void {
      breaker.retry()
      notified = false
      report()
    },

    available(): boolean {
      if (!deps.hasKey()) return false
      return breaker.blocked(now()) === undefined
    },
  }

  async function speakReply(text: string): Promise<void> {
    const mine = ++generation
    reply?.abort()
    const controller = new AbortController()
    reply = controller
    // Cleaned as the local voices clean it: markdown, code and links are not
    // read aloud, and on MAI they would be paid for by the character too.
    const clean = cleanForSpeech(text).trim()
    if (clean.length === 0) return
    const { voice } = deps.voiceFor(clean)
    const mai = maiVoiceOf(voice)
    if (!mai) {
      await deps.local.speak(clean)
      return
    }
    const hadKey = deps.hasKey()
    if (!hadKey) {
      await sayLocal(mine, clean, "no-key", false)
      return
    }
    const blocked = breaker.blocked(deps.client.now?.() ?? Date.now())
    if (blocked) {
      await sayLocal(mine, clean, blocked.kind, true)
      return
    }

    const units = splitSentences(clean)
    let pending = units
    for (let i = 0; i < units.length; i++) {
      if (mine !== generation) return
      // Not a breaker trip: the key is read before every sentence, so one
      // put back is used at once instead of after a cooldown.
      if (!deps.hasKey()) {
        await sayLocal(mine, pending.join(" "), "no-key", true)
        return
      }
      const unit = units[i]!
      const sentAt = now()
      const reserved = reserveMai(unit)
      if (deps.spend) {
        // Before the request, not after: a cap that is checked once the money is spent is a report, not a cap.
        if (maiCapReached(deps.spend.tally.today(sentAt), reserved)) {
          const today = dayOf(sentAt)
          if (capToldOn === today) notified = true
          else {
            capToldOn = today
            notified = false
          }
          await sayLocal(mine, pending.join(" "), "cap", true)
          return
        }
        deps.spend.tally.addReply(sentAt, reserved)
      }
      try {
        const result = await speakMai({ voice: mai, text: unit, signal: controller.signal }, deps.client)
        if (mine !== generation) return
        breaker.reset()
        const id = result.generationId
        const spend = deps.spend
        if (id && spend?.settle) {
          void spend
            .settle(id)
            .then((actual) => {
              if (actual !== undefined) spend.tally.settleReply(id, sentAt, actual - reserved, now())
            })
            .catch(() => undefined)
        }
        deps.onSpoken?.({
          generationId: result.generationId,
          reservedUsd: result.reservedUsd,
          chars: unit.length,
        })
        await deps.play(result.wav, controller.signal)
        if (mine !== generation) return
        // The outage is over once a sentence was heard, not once it was synthesised.
        notified = false
      } catch (error) {
        if (mine !== generation) return
        const kind = error instanceof MaiError ? error.kind : "transient"
        // A refusal synthesised nothing: the reservation goes back, under an id of its own so it is given back once.
        if (deps.spend && REFUNDED.has(kind)) {
          deps.spend.tally.settleReply(`refund-${sentAt}-${++refunds}`, sentAt, -reserved, now())
        }
        if (kind === "aborted") return
        breaker.trip(
          kind,
          deps.client.now?.() ?? Date.now(),
          error instanceof MaiError ? error.retryAfterMs : undefined,
        )
        await sayLocal(mine, pending.join(" "), kind, true)
        return
      }
      pending = units.slice(i + 1)
    }
  }
}

export { reserveMai }
