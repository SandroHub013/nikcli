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
 * The first sentence after the voice starts. Piper reads stdin only once it
 * has loaded its 63 MB model, and that first «Pronto.» took 22 s live: with
 * the short limit the client gave up before the host had answered, and the
 * first reply of a session came out in the old voice. The host waits 90 s for
 * the same sentence (`FIRST_SYNTHESIS_TIMEOUT` in `tts.rs`), and the client has
 * to be the narrower of the two, as it is for the ones after: half of 90 s,
 * against 15 s against 30 s.
 */
export const FIRST_SYNTHESIS_LIMIT_MS = 45_000

/**
 * How long silence lasts without sentences to speak before the resident Piper
 * process is shut down to free its ~98 MB of memory (P1-C4). 2 minutes.
 */
export const SILENCE_STOP_LIMIT_MS = 120_000

const STOP_RETRY_MS = 250

function withinLimit<T>(pending: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("La voce naturale non ha risposto in tempo.")), ms)
  })
  return Promise.race([pending, expired]).finally(() => clearTimeout(timer))
}

/**
 * Names each synthesis request for the host, so an abandoned one can be
 * cancelled there. Shared by every speaker and started from the clock: the
 * host keeps its abandoned set across a page reload while a counter from
 * zero would start again at 1, and the orphan mark would silently skip the
 * phrase that happened to draw the same number.
 */
let tokenSeq = Date.now() * 1000

/**
 * How long the sentence due now may keep the reply silent: the long one while
 * the host's process may still be loading its model, the short one after.
 * `synthesisLimitMs` is a test's way of saying "every sentence", so it wins.
 */
export function synthesisLimitMs(state: {
  fresh: boolean
  synthesisLimitMs?: number
  firstSynthesisLimitMs?: number
}): number {
  if (state.synthesisLimitMs !== undefined) return state.synthesisLimitMs
  if (!state.fresh) return SYNTHESIS_LIMIT_MS
  return state.firstSynthesisLimitMs ?? FIRST_SYNTHESIS_LIMIT_MS
}

export interface NaturalSpeakerDeps {
  voice: () => string
  /** Whether the voice can speak now, and whether it can ever on this host. */
  status: (voice: string) => Promise<{ supported: boolean; installed: boolean }>
  /** Downloads what the voice needs. Called once per voice, in the background. */
  install: (voice: string) => Promise<void>
  /**
   * One sentence as WAV bytes. `token` names this request on the host, so
   * `cancel` can tell it to skip the sentence if the reply is abandoned while
   * the sentence still waits its turn in the queue.
   */
  synthesize: (voice: string, text: string, token: number) => Promise<ArrayBuffer>
  /**
   * Abandons the named requests: the host skips their queued sentences at
   * their turn, and the one already being synthesised finishes on its own.
   * Called with exactly the in-flight requests no longer waited for — never
   * with the ones asked for ahead of the next reply.
   */
  cancel?: (tokens: number[]) => void | Promise<void>
  /** Plays WAV bytes; resolves when done, or when `signal` aborts. */
  play: (wav: ArrayBuffer, signal: AbortSignal) => Promise<void>
  /** How long one sentence may take; `SYNTHESIS_LIMIT_MS` unless a test needs less. Set, it covers the first one too. */
  synthesisLimitMs?: number
  /** How long the first sentence after a start may take; `FIRST_SYNTHESIS_LIMIT_MS` unless a test needs less. */
  firstSynthesisLimitMs?: number
  /** What speaks while Piper cannot. */
  fallback: Speaker
  /** Stop a resident process left by a previous page before this one uses it. */
  stopOnCreate?: boolean
  /** Told once when a download starts, ends or fails, for the settings panel. */
  onInstall?: (voice: string, state: "downloading" | "ready" | "failed", problem?: string) => void
  /** Spoken notice when natural voice is chosen but unavailable before using system voice. */
  fallbackNotice?: () => string
  /** Shuts down the resident process on the host after silence, freeing memory (P1-C4). */
  stop?: () => Promise<{ busy: boolean }> | { busy: boolean }
  /** How long silence lasts before Piper is shut down (default 120_000 ms = 2 min). */
  idleLimitMs?: number
  stopRetryMs?: number
  stopDeadlineMs?: number
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
  const failed = new Set<string>()
  let warmed: string | undefined
  let fallbackNotified = false
  /** Tokens of the requests asked of the host and not settled yet. */
  const inflight = new Set<number>()

  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let stopping: Promise<void> | undefined
  let activeTasks = 0
  let residentStarted = false
  /**
   * True until the host has answered one sentence: its resident process may
   * still be loading the model, and that first answer is the slow one. A
   * refusal counts as an answer, so a voice that is broken rather than slow
   * does not make every reply wait out the long limit.
   */
  let fresh = true

  /** How long the sentence due now may keep the reply silent. */
  function limitMs(): number {
    return synthesisLimitMs({
      fresh,
      synthesisLimitMs: deps.synthesisLimitMs,
      firstSynthesisLimitMs: deps.firstSynthesisLimitMs,
    })
  }

  function confirmStop(): Promise<boolean> {
    const stop = deps.stop
    if (!stop) return Promise.resolve(true)
    const startedAt = Date.now()
    const deadlineMs = deps.stopDeadlineMs ?? SYNTHESIS_LIMIT_MS
    const retryMs = deps.stopRetryMs ?? STOP_RETRY_MS
    const ask = async (): Promise<boolean> => {
      const { busy } = await stop()
      if (!busy) {
        residentStarted = false
        fresh = true
        warmed = undefined
        return true
      }
      if (Date.now() - startedAt < deadlineMs) {
        await new Promise<void>((resolve) => setTimeout(resolve, retryMs))
        return ask()
      }
      return false
    }
    return ask().catch(() => false)
  }

  function beginStop(): void {
    if (stopping) return
    const pending: Promise<void> = confirmStop().then((confirmed) => {
      if (stopping === pending) stopping = undefined
      if (confirmed) return
      residentStarted = true
      if (activeTasks === 0) scheduleIdleStop()
    })
    stopping = pending
  }

  if (deps.stopOnCreate === true) beginStop()

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
      beginStop()
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

  function invokeSynthesize(voice: string, sentence: string): { token: number; pending: Promise<ArrayBuffer> } {
    const token = ++tokenSeq
    inflight.add(token)
    const send = (): Promise<ArrayBuffer> => {
      residentStarted = true
      return deps.synthesize(voice, sentence, token)
    }
    const pending = stopping ? stopping.catch(() => {}).then(send) : send()
    const forget = () => {
      inflight.delete(token)
      // The host has spoken, one way or the other: from here on it is warm.
      fresh = false
    }
    void pending.then(forget, forget)
    return { token, pending }
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
  const ahead = new Map<string, { token: number; pending: Promise<ArrayBuffer> }>()
  const aheadKey = (voice: string, sentence: string) => `${voice}\u0000${sentence}`
  function synthesize(voice: string, sentence: string): Promise<ArrayBuffer> {
    residentStarted = true
    const key = aheadKey(voice, sentence)
    const early = ahead.get(key)
    if (early) {
      ahead.delete(key)
      return early.pending
    }
    return invokeSynthesize(voice, sentence).pending
  }

  function ensure(voice: string): void {
    if (ready.has(voice) || installing.has(voice) || failed.has(voice)) return
    deps.onInstall?.(voice, "downloading")
    const job = deps
      .install(voice)
      .then(() => {
        ready.add(voice)
        failed.delete(voice)
        deps.onInstall?.(voice, "ready")
      })
      .catch((error: unknown) => {
        failed.add(voice)
        deps.onInstall?.(voice, "failed", error instanceof Error ? error.message : String(error))
      })
      .finally(() => installing.delete(voice))
    installing.set(voice, job)
  }

  async function usable(voice: string, installIfMissing = true): Promise<boolean> {
    if (voice === "system") return false
    if (ready.has(voice)) return true
    try {
      const { supported, installed } = await deps.status(voice)
      if (!supported) return false
      if (installed) {
        ready.add(voice)
        failed.delete(voice)
        return true
      }
      if (installIfMissing) ensure(voice)
    } catch {
      // A host that cannot say is a host that cannot speak with Piper.
    }
    return false
  }

  /**
   * Drops everything of the old reply. The sentences still queued in the host
   * are abandoned there too — they would only delay the next reply — except
   * those kept: the ones already asked for ahead of the reply to come.
   */
  function stopAll(keep?: ReadonlySet<number>): void {
    generation++
    playing?.abort()
    playing = undefined
    deps.fallback.cancel()
    ahead.clear()
    const abandoned = [...inflight].filter((token) => !keep?.has(token))
    if (abandoned.length > 0) void deps.cancel?.(abandoned)
  }

  return {
    async speak(text: string): Promise<void> {
      cancelIdleTimer()
      activeTasks++
      try {
        await ensureNotStopping()
        // What was asked for ahead belongs to this reply: kept across the stop.
        const early = new Map(ahead)
        stopAll(new Set([...early.values()].map((entry) => entry.token)))
        for (const [key, entry] of early) ahead.set(key, entry)
        const mine = generation
        if (!text || text.trim().length === 0) return
        const clean = cleanForSpeech(text)
        if (!clean || clean.trim().length === 0) return
        const voice = deps.voice()
        if (!(await usable(voice))) {
          if (mine === generation) {
            await announceFallbackOnce(voice)
            if (mine !== generation) return
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
            wav = await withinLimit(audio[i]!, limitMs())
          } catch {
            // The rest of the reply goes out in the old voice rather than not at all.
            if (mine === generation) {
              await announceFallbackOnce(voice)
              if (mine !== generation) return
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
              if (mine !== generation) return
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
        const { token, pending } = invokeSynthesize(voice, sentence)
        const tracked = pending.finally(() => {
          activeTasks--
          if (activeTasks === 0) scheduleIdleStop()
        })
        tracked.catch(() => {})
        ahead.set(key, { token, pending: tracked })
      }
    },

    prepare(): void {
      const voice = deps.voice()
      if (voice === warmed) return
      cancelIdleTimer()
      void usable(voice, false).then((ok) => {
        if (!ok || warmed === voice) return
        warmed = voice
        residentStarted = true
        activeTasks++
        const { pending } = invokeSynthesize(voice, "Pronto.")
        pending
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
