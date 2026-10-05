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
import { splitSentences } from "./natural-speaker"
import { isMaiVoice, maiVoice, type MaiVoiceId } from "../settings/reply-voices"
import { createMaiBreaker, MaiError, reserveMai, speakMai, type MaiClientDeps, type MaiFailureKind } from "./mai"

export interface MaiSpeakerDeps {
  /** The voice the reply is read in, already resolved for its language. */
  voiceFor: (text: string) => { voice: string; locale: string }
  /** Whether a key is present right now. Read per reply: one removed mid-reply is gone. */
  hasKey: () => boolean
  client: MaiClientDeps
  /** What reads whatever MAI does not. */
  local: Speaker
  /** Plays one WAV and resolves when it ends, or when `cancel` aborts it. */
  play: (wav: ArrayBuffer) => Promise<void>
  /**
   * Said once when MAI gives up, before the local voice takes the rest.
   * `payment` is the one with its own sentence, because it is the one the user
   * can fix by adding credit.
   */
  notice: (kind: MaiFailureKind, keyWasPresent: boolean) => string | undefined
  /** A sentence was spoken, with what it was reserved at. Settlement is the caller's. */
  onSpoken?: (info: { generationId?: string; reservedUsd: number; chars: number }) => void
}

export interface MaiSpeaker extends Speaker {
  /** Opens the breaker whatever closed it. The panel's «Riprova». */
  retry(): void
  /** Whether MAI would be asked for this voice right now. */
  available(): boolean
}

/** What the user is told, once, when the cloud voice cannot answer. */
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
  if (kind === "no-key") return keyWasPresent ? "Manca la chiave OpenRouter: uso la voce locale." : undefined
  return "La voce cloud non è disponibile: uso la voce locale."
}

export function createMaiSpeaker(deps: MaiSpeakerDeps): MaiSpeaker {
  const breaker = createMaiBreaker()
  let generation = 0
  let notified = false

  function maiVoiceOf(voice: string): MaiVoiceId | undefined {
    if (!isMaiVoice(voice as MaiVoiceId)) return undefined
    return maiVoice(voice as MaiVoiceId)?.id
  }

  async function sayLocal(text: string, kind: MaiFailureKind, keyWasPresent: boolean): Promise<void> {
    if (!notified) {
      notified = true
      const line = deps.notice(kind, keyWasPresent)
      if (line) await deps.local.speak(line)
    }
    if (text.trim().length > 0) await deps.local.speak(text)
  }

  return {
    async speak(text: string): Promise<void> {
      const mine = ++generation
      const clean = text.trim()
      if (clean.length === 0) return
      const { voice } = deps.voiceFor(clean)
      const mai = maiVoiceOf(voice)
      if (!mai) {
        await deps.local.speak(clean)
        return
      }
      const hadKey = deps.hasKey()
      if (!hadKey) {
        await sayLocal(clean, "no-key", false)
        return
      }
      const blocked = breaker.blocked(deps.client.now?.() ?? Date.now())
      if (blocked) {
        await sayLocal(clean, blocked.kind, true)
        return
      }

      const units = splitSentences(clean)
      let pending = units
      for (let i = 0; i < units.length; i++) {
        if (mine !== generation) return
        if (!deps.hasKey()) {
          breaker.trip("no-key", deps.client.now?.() ?? Date.now())
          await sayLocal(pending.join(" "), "no-key", true)
          return
        }
        const unit = units[i]!
        try {
          const result = await speakMai({ voice: mai, text: unit }, deps.client)
          if (mine !== generation) return
          breaker.reset()
          notified = false
          deps.onSpoken?.({
            generationId: result.generationId,
            reservedUsd: result.reservedUsd,
            chars: unit.length,
          })
          await deps.play(result.wav)
        } catch (error) {
          if (mine !== generation) return
          const kind = error instanceof MaiError ? error.kind : "transient"
          if (kind === "aborted") return
          breaker.trip(
            kind,
            deps.client.now?.() ?? Date.now(),
            error instanceof MaiError ? error.retryAfterMs : undefined,
          )
          await sayLocal(pending.join(" "), kind, true)
          return
        }
        pending = units.slice(i + 1)
      }
    },

    cancel(): void {
      generation++
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
    },

    available(): boolean {
      if (!deps.hasKey()) return false
      return breaker.blocked(deps.client.now?.() ?? Date.now()) === undefined
    },
  }
}

export { reserveMai }
