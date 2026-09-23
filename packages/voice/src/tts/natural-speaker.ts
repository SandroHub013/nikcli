/**
 * The assistant's natural voice: Piper through the desktop host, sentence by sentence.
 *
 * The Web Speech voices WebView2 has on Windows are the old OneCore ones, and
 * the user heard them as a robot. S15 picked Piper (offline, a resident
 * process on the host side) and a male voice. This speaker only decides what
 * to say when: the host synthesises, a player plays.
 *
 * Sentence by sentence, because Piper answers a whole line at a time: a reply
 * of three sentences sent as one would stay silent until all three were
 * ready. Every sentence is requested at once and played in order, so the
 * first one starts after ~0.3 s and the next is usually waiting when it ends.
 *
 * The Web Speech speaker stays underneath, and takes over whenever Piper
 * cannot answer: the voice is still downloading, the host is not Windows, or
 * a sentence failed. A reply is never lost to the better voice being absent.
 */

import { markVoice } from "../timing"
import { cleanForSpeech } from "./clean"
import type { Speaker } from "./speaker"

/**
 * How long a sentence may keep the reply silent. Piper answers a line in well
 * under a second once warm; a host that has not answered in this long is stuck
 * (its resident process holds a lock while it waits), and without a limit the
 * dialogue waited with it, for ever.
 */
export const SYNTHESIS_LIMIT_MS = 15_000

/**
 * How long silence lasts without sentences to speak before the resident Piper
 * process is shut down to free its ~98 MB of memory (P1-C4). 2 minutes.
 */
export const SILENCE_STOP_LIMIT_MS = 120_000

function withinLimit<T>(pending: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("La voce naturale non ha risposto in tempo.")), ms)
  })
  return Promise.race([pending, expired]).finally(() => clearTimeout(timer))
}

export interface NaturalSpeakerDeps {
  /** The chosen voice id, read at every reply so a change in the settings applies at once. `system` means Web Speech. */
  voice: () => string
  /** Whether the voice can speak now, and whether it can ever on this host. */
  status: (voice: string) => Promise<{ supported: boolean; installed: boolean }>
  /** Downloads what the voice needs. Called once per voice, in the background. */
  install: (voice: string) => Promise<void>
  /** One sentence as WAV bytes. */
  synthesize: (voice: string, text: string) => Promise<ArrayBuffer>
  /** Plays WAV bytes; resolves when done, or when `signal` aborts. */
  play: (wav: ArrayBuffer, signal: AbortSignal) => Promise<void>
  /** How long one sentence may take; `SYNTHESIS_LIMIT_MS` unless a test needs less. */
  synthesisLimitMs?: number
  /** What speaks while Piper cannot. */
  fallback: Speaker
  /** Told once when a download starts, ends or fails, for the settings panel. */
  onInstall?: (voice: string, state: "downloading" | "ready" | "failed", problem?: string) => void
  /** Spoken notice when natural voice is chosen but unavailable before using system voice. */
  fallbackNotice?: () => string
  /** Shuts down the resident process on the host after silence, freeing memory (P1-C4). */
  stop?: () => Promise<void> | void
  /** How long silence lasts before Piper is shut down (default 120_000 ms = 2 min). */
  idleLimitMs?: number
}

/**
 * Splits a reply into the sentences Piper reads one at a time.
 *
 * On `.`, `!`, `?`, `;` and `…` followed by a space, so "3.5" and "v1.2" stay
 * whole; very short pieces are joined to the next, since a lone "Fatto." costs
 * a round trip for half a second of audio.
 */
export function splitSentences(text: string, minLength = 12): string[] {
  const pieces = text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?;…])\s+/)
    .filter((piece) => piece.length > 0)
  const sentences: string[] = []
  for (const piece of pieces) {
    const last = sentences.at(-1)
    if (last !== undefined && last.length < minLength) sentences[sentences.length - 1] = `${last} ${piece}`
    else sentences.push(piece)
  }
  return sentences
}

export interface NaturalSpeaker extends Speaker {
  /**
   * Gets the voice ready before the first reply: starts its download, or has
   * the host load it with a sentence nobody hears.
   *
   * Loading is what costs: the first sentence after Piper starts took 1.4–1.6 s
   * in ADE Test, every later one 0.22–0.32 s. Called when the microphone
   * opens, the reply that follows finds the voice warm. Once per voice.
   */
  prepare(): void
}

export function createNaturalSpeaker(deps: NaturalSpeakerDeps): NaturalSpeaker {
  let generation = 0
  let playing: AbortController | undefined
  /** Voices known to be installed, and the downloads already started. */
  const ready = new Set<string>()
  const installing = new Map<string, Promise<void>>()
  let warmed: string | undefined
  let fallbackNotified = false

  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let stopping: Promise<void> | undefined
  let activeTasks = 0
  let residentStarted = false

  function cancelIdleTimer(): void {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer)
      idleTimer = undefined
    }
  }

  function scheduleIdleStop(): void {
    cancelIdleTimer()
    if (!deps.stop || !residentStarted || activeTasks > 0) return
    const timeoutMs = deps.idleLimitMs ?? SILENCE_STOP_LIMIT_MS
    idleTimer = setTimeout(() => {
      idleTimer = undefined
      residentStarted = false
      warmed = undefined
      const pending = deps.stop?.()
      if (pending && typeof (pending as Promise<void>).then === "function") {
        stopping = (pending as Promise<void>).finally(() => {
          if (stopping === pending) stopping = undefined
        })
      }
    }, timeoutMs)
  }

  async function ensureNotStopping(): Promise<void> {
    if (stopping) {
      try {
        await stopping
      } catch {
        // A failure to stop an old process must not keep the new reply silent.
      }
    }
  }

  function invokeSynthesize(voice: string, sentence: string): Promise<ArrayBuffer> {
    if (stopping) {
      return stopping.catch(() => {}).then(() => deps.synthesize(voice, sentence))
    }
    return deps.synthesize(voice, sentence)
  }

  async function announceFallbackOnce(voice: string): Promise<void> {
    if (voice === "system" || fallbackNotified || !deps.fallbackNotice) return
    fallbackNotified = true
    const notice = deps.fallbackNotice()
    if (notice && notice.trim().length > 0) {
      await deps.fallback.speak(notice)
    }
  }

  /* Sentences asked for ahead of their turn, by voice and text. */
  const ahead = new Map<string, Promise<ArrayBuffer>>()
  const aheadKey = (voice: string, sentence: string) => `${voice}\u0000${sentence}`
  function synthesize(voice: string, sentence: string): Promise<ArrayBuffer> {
    residentStarted = true
    const key = aheadKey(voice, sentence)
    const early = ahead.get(key)
    if (early) {
      ahead.delete(key)
      return early
    }
    return invokeSynthesize(voice, sentence)
  }

  function ensure(voice: string): void {
    if (ready.has(voice) || installing.has(voice)) return
    deps.onInstall?.(voice, "downloading")
    const job = deps
      .install(voice)
      .then(() => {
        ready.add(voice)
        deps.onInstall?.(voice, "ready")
      })
      .catch((error: unknown) => {
        deps.onInstall?.(voice, "failed", error instanceof Error ? error.message : String(error))
      })
      .finally(() => installing.delete(voice))
    installing.set(voice, job)
  }

  async function usable(voice: string): Promise<boolean> {
    if (voice === "system") return false
    if (ready.has(voice)) return true
    try {
      const { supported, installed } = await deps.status(voice)
      if (!supported) return false
      if (installed) {
        ready.add(voice)
        return true
      }
      ensure(voice)
    } catch {
      // A host that cannot say is a host that cannot speak with Piper.
    }
    return false
  }

  function stopAll(): void {
    generation++
    playing?.abort()
    playing = undefined
    deps.fallback.cancel()
    ahead.clear()
  }

  return {
    async speak(text: string): Promise<void> {
      cancelIdleTimer()
      activeTasks++
      try {
        await ensureNotStopping()
        // What was asked for ahead belongs to this reply: kept across the stop.
        const early = new Map(ahead)
        stopAll()
        for (const [key, pending] of early) ahead.set(key, pending)
        const mine = generation
        if (!text || text.trim().length === 0) return
        const clean = cleanForSpeech(text)
        if (!clean || clean.trim().length === 0) return
        const voice = deps.voice()
        if (!(await usable(voice))) {
          if (mine === generation) {
            await announceFallbackOnce(voice)
            await deps.fallback.speak(clean)
          }
          return
        }
        fallbackNotified = false
        if (mine !== generation) return

        const sentences = splitSentences(clean)
        // Requested together, played in order: the host works through them while the first plays.
        const audio = sentences.map((sentence) => synthesize(voice, sentence))
        audio.forEach((pending) => pending.catch(() => {}))
        for (let i = 0; i < sentences.length; i++) {
          let wav: ArrayBuffer
          try {
            // Timed from when this sentence is due, not when it was queued behind the others.
            wav = await withinLimit(audio[i]!, deps.synthesisLimitMs ?? SYNTHESIS_LIMIT_MS)
          } catch {
            // The rest of the reply goes out in the old voice rather than not at all.
            if (mine === generation) {
              await announceFallbackOnce(voice)
              await deps.fallback.speak(sentences.slice(i).join(" "))
            }
            return
          }
          if (mine !== generation) return
          const controller = new AbortController()
          playing = controller
          markVoice("audio-start", sentences[i])
          try {
            await deps.play(wav, controller.signal)
          } catch {
            // Synthesised but not playable: the old voice still gets the words out.
            if (mine === generation) {
              await announceFallbackOnce(voice)
              await deps.fallback.speak(sentences.slice(i).join(" "))
            }
            return
          }
          if (mine !== generation) return
        }
        playing = undefined
      } finally {
        activeTasks--
        if (activeTasks === 0) {
          scheduleIdleStop()
        }
      }
    },

    cancel(): void {
      stopAll()
      if (activeTasks === 0) {
        scheduleIdleStop()
      }
    },

    prefetch(text: string): void {
      if (!text || text.trim().length === 0) return
      const clean = cleanForSpeech(text)
      if (!clean || clean.trim().length === 0) return
      const voice = deps.voice()
      if (voice === "system" || !ready.has(voice)) return
      cancelIdleTimer()
      for (const sentence of splitSentences(clean)) {
        const key = aheadKey(voice, sentence)
        if (ahead.has(key)) continue
        residentStarted = true
        activeTasks++
        const pending = invokeSynthesize(voice, sentence)
          .finally(() => {
            activeTasks--
            if (activeTasks === 0) scheduleIdleStop()
          })
        pending.catch(() => {})
        ahead.set(key, pending)
      }
    },

    prepare(): void {
      const voice = deps.voice()
      if (voice === warmed) return
      cancelIdleTimer()
      void usable(voice).then((ok) => {
        if (!ok || warmed === voice) return
        warmed = voice
        residentStarted = true
        activeTasks++
        invokeSynthesize(voice, "Pronto.")
          .catch(() => {
            warmed = undefined
          })
          .finally(() => {
            activeTasks--
            if (activeTasks === 0) scheduleIdleStop()
          })
      })
    },
  }
}
