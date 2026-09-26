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
import { isKokoroVoice } from "../settings/reply-voices"
import type { ReplyVoice, TtsLocale } from "../settings/model"
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
  /**
   * The G2P locale the replies are spoken in, and the only place it comes from.
   *
   * Not deduced from the voice id and not the interface's language: a voice is
   * not a language, and a locale the synthesiser does not know fails on the
   * sentence rather than on the setting. Required, because a default here would
   * be a silent Italian on an English machine.
   */
  ttsLocale: () => TtsLocale
  /** Whether the voice can speak now, and whether it can ever on this host. */
  status: (voice: string) => Promise<{ supported: boolean; installed: boolean }>
  /** Downloads what the voice needs. Called once per voice, in the background. */
  install: (voice: string) => Promise<void>
  /**
   * One unit as WAV bytes. `token` names this request on the host, so `cancel`
   * can tell it to skip the unit if the reply is abandoned while it still waits
   * its turn in the queue, and `locale` is the G2P locale to synthesise it in.
   *
   * `locale` is last because it was added last, and a Piper bridge does not
   * read it: a Piper voice is one language, and which one is in its name.
   */
  synthesize: (voice: string, text: string, token: number, locale: TtsLocale) => Promise<ArrayBuffer>
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

/**
 * What one character costs to say: a digit four, anything else one.
 *
 * "2026" is said with more words than it is written with, so a first unit of
 * thirty characters that happens to be a date is three times the work of one
 * that is not — and the cap is the only thing standing between the user and a
 * second of silence.
 */
function charWeight(character: string): number {
  return character >= "0" && character <= "9" ? 4 : 1
}

/** How heavy a piece of text is to speak, in the units K1 measured. */
export function speechWeight(text: string): number {
  let weight = 0
  for (const character of text) weight += charWeight(character)
  return weight
}

/** The cap on the first unit, in weight. K1's first unit is a fraction of a second. */
export const FIRST_UNIT_WEIGHT = 30

/**
 * Past this cap the progressive cut stops paying.
 *
 * A unit of 160 weight is about 2,5 s of audio, and a synthesis costs a fixed
 * 150 ms plus 0,3 ms per millisecond of it: past that the request is longer
 * than the audio it produces, and a whole sentence is a better unit than a
 * piece of one.
 */
export const WHOLE_SENTENCES_ABOVE_WEIGHT = 160

/** How much bigger than everything queued so far the next unit may be. */
export const UNIT_GROWTH = 2.5

/** Where a unit may be cut: a pause is worth more than a word boundary. */
const CUT_AFTER = ",:;—–)"

/**
 * The reply as the units the host synthesises, for a voice that is slow to
 * start.
 *
 * Kokoro does not answer with audio it can play while it keeps thinking: a
 * synthesis is about 150 ms plus three tenths of the audio it produces, and it
 * produces all of it at once. So the time to the first sound is the time to
 * synthesise the whole first unit, and a first sentence of three seconds is
 * three seconds of silence in front of the answer. K1 measured it on this
 * machine: a flat 60-character cut left gaps, and a first unit under a cap that
 * grows with what is already queued left none.
 *
 * The cap grows, and that is the point: the first unit is short because the
 * user is waiting, and the second may be two and a half times as long because
 * the first is already playing. Past a unit of 160 weight the units are whole
 * sentences again, because by then the queue is deep enough to cover the
 * synthesis of the next.
 *
 * Not used for Piper: its sentences already arrive in a fraction of a second,
 * and a voice that works is not worth re-chopping.
 */
export function splitUnits(text: string): string[] {
  const units: string[] = []
  /** The weight of everything produced so far: the base the next cap grows from. */
  let queued = 0
  for (const sentence of splitSentences(text)) {
    const cap = queued === 0 ? FIRST_UNIT_WEIGHT : queued * UNIT_GROWTH
    if (speechWeight(sentence) <= cap || cap > WHOLE_SENTENCES_ABOVE_WEIGHT) {
      units.push(sentence)
      queued += speechWeight(sentence)
      continue
    }
    for (const piece of cutTo(sentence, cap)) {
      units.push(piece)
      queued += speechWeight(piece)
    }
  }
  return units.filter((unit) => unit.length > 0)
}

/** `sentence` in pieces of at most `cap` weight each, never ending mid-word. */
function cutTo(sentence: string, cap: number): string[] {
  const pieces: string[] = []
  let rest = sentence.trim()
  while (speechWeight(rest) > cap) {
    const head = rest.slice(0, headLength(rest, cap)).trim()
    if (head.length === 0) break
    pieces.push(head)
    rest = rest.slice(head.length).trim()
  }
  if (rest.length > 0) pieces.push(rest)
  return pieces
}

/** How much of `rest` the first piece takes, in characters. */
function headLength(rest: string, cap: number): number {
  const half = cap / 2
  let weight = 0
  /** A pause at or before half the cap: better than a space, used second. */
  let pause = 0
  /** The last space whose piece still fits in the cap, in weight and not in
   * characters — a date is three times the words it is written with. */
  let space = 0
  /** The first place the cap is passed, for a word too long to fit at all. */
  let overCap = 0
  for (let at = 0; at < rest.length; at++) {
    const character = rest[at]!
    if (overCap === 0 && weight > cap) overCap = at
    if (character === " " && weight <= cap) space = at
    if (CUT_AFTER.includes(character) && rest[at + 1] === " ") {
      // Past half the cap and at a pause: where a speaker would have breathed.
      if (weight > half) return at + 1
      pause = at + 1
    }
    weight += charWeight(character)
  }
  if (pause > 0) return pause
  if (space > 0) return space
  // A single word longer than the cap: cut where the cap is passed, so the
  // piece still ends somewhere and the next one starts on a character.
  return overCap > 0 ? overCap : rest.length
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
  /**
   * Whether a sentence of a reply is waiting for the voice, which is also what
   * the stop in flight is about: a stop that is only retrying gives up, because
   * it is freeing a process somebody is asking to speak through.
   */
  let askedFor = false
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
      /* The voice is being asked for again, so this stop has nothing left to
         free. It was worth one request: the process it frees is the one the
         sentence is about to need, and a request already at the host cannot be
         un-made — which is why the sentence still goes out behind it, a round
         trip away. What must not happen is the retries: they used to sit
         inside the sentence's own limit, so a stop that never confirmed could
         spend the whole of it and the reply left in the system voice. */
      if (askedFor) return false
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
      // The next stop starts from nothing: a voice asked for once is not a
      // voice that must never be freed again.
      askedFor = false
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
      return deps.synthesize(voice, sentence, token, deps.ttsLocale())
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
    // The voice is needed again, so a stop in flight has nothing left to free.
    askedFor = true
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
   * The reply as the units this voice is played in.
   *
   * Whole sentences for Piper, which answers one in a fraction of a second, and
   * the growing cut for Kokoro, which does not answer until it has synthesised
   * all of a unit: see `splitUnits`.
   */
  function unitsOf(voice: string, text: string): string[] {
    return (isKokoroVoice(voice as ReplyVoice) ? splitUnits : splitSentences)(text)
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
      // Said before the wait below, which is the whole point: a reply that finds
      // a stop still confirming is a voice that is needed again, and the stop
      // must stop being asked for rather than hold the first sentence behind it.
      askedFor = true
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

        const sentences = unitsOf(voice, clean)
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
      for (const sentence of unitsOf(voice, clean)) {
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
