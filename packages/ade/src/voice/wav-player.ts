import { wavEnvelope, type PlaybackMeter } from "@nikcli-ai/voice/core"

/**
 * Plays one WAV the voice host synthesised, on the chosen output device.
 *
 * An `<audio>` element rather than an AudioContext: it takes the WAV as it is,
 * and `setSinkId` puts it on the output the user picked in the voice settings,
 * which Web Speech could never honour. For the same reason the agent's orb
 * reads the voice's loudness from the WAV itself (`meter`), at the element's
 * current time, rather than from an analyser in the audio path.
 */
export function playWav(wav: ArrayBuffer, signal: AbortSignal, outputDeviceId?: string, meter?: PlaybackMeter): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  const envelope = meter ? wavEnvelope(wav) : undefined
  const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }))
  const audio = new Audio(url)
  return new Promise<void>((resolve) => {
    let untrack: (() => void) | undefined
    const done = () => {
      untrack?.()
      audio.pause()
      audio.removeAttribute("src")
      URL.revokeObjectURL(url)
      signal.removeEventListener("abort", done)
      resolve()
    }
    audio.addEventListener("ended", done, { once: true })
    audio.addEventListener("error", done, { once: true })
    signal.addEventListener("abort", done, { once: true })
    const sink = outputDeviceId && "setSinkId" in audio
      ? (audio as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(outputDeviceId).catch(() => {})
      : Promise.resolve()
    void sink.then(() => {
      if (signal.aborted) return
      if (meter && envelope) untrack = meter.track(envelope, () => audio.currentTime)
      return audio.play().catch(done)
    })
  })
}
