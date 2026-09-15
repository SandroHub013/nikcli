/**
 * Plays one WAV the voice host synthesised, on the chosen output device.
 *
 * An `<audio>` element rather than an AudioContext: it takes the WAV as it is,
 * and `setSinkId` puts it on the output the user picked in the voice settings,
 * which Web Speech could never honour.
 */
export function playWav(wav: ArrayBuffer, signal: AbortSignal, outputDeviceId?: string): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }))
  const audio = new Audio(url)
  return new Promise<void>((resolve) => {
    const done = () => {
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
    void sink.then(() => (signal.aborted ? undefined : audio.play().catch(done)))
  })
}
