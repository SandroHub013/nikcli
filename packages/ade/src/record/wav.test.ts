import { describe, expect, test } from "bun:test"
import { buildVoiceTrack, readWav, writeWav } from "./wav"

const tone = (sampleRate: number, values: number[], channels = 1) =>
  writeWav({ sampleRate, channels, samples: Int16Array.from(values) })

const flat = (sampleRate: number, count: number, value: number) => tone(sampleRate, Array(count).fill(value))

/** `tone` with one header field overwritten, for the shapes the track refuses. */
const bent = (offset: number, value: number, size: 16 | 32 = 16) => {
  const wav = tone(24000, [1, 2])
  const view = new DataView(wav)
  if (size === 16) view.setUint16(offset, value, true)
  else view.setUint32(offset, value, true)
  return wav
}

describe("record/wav", () => {
  test("a WAV reads back as the samples written", () => {
    const pcm = readWav(tone(22050, [0, 1000, -1000, 32767]))
    expect(pcm?.sampleRate).toBe(22050)
    expect(pcm?.channels).toBe(1)
    expect(Array.from(pcm!.samples)).toEqual([0, 1000, -1000, 32767])
  })

  test("anything that is not 16-bit PCM is refused, not guessed at", () => {
    expect(readWav(new ArrayBuffer(10))).toBeUndefined()
    const float = tone(22050, [1, 2])
    new DataView(float).setUint16(20, 3, true) // IEEE float
    expect(readWav(float)).toBeUndefined()
    const text = new TextEncoder().encode("RIFF....WAVEnope, not a wav at all.......").buffer as ArrayBuffer
    expect(readWav(text)).toBeUndefined()
  })

  test("clips land on one timeline at the moment they were said, silence between", () => {
    // At 24 kHz a millisecond is 24 samples.
    const track = buildVoiceTrack(
      [
        { at: 0, wav: tone(24000, [5, 5]) },
        { at: 1, wav: tone(24000, [7]) },
      ],
      2,
    )
    expect(track?.skipped).toBe(0)
    const expected = Array(48).fill(0)
    expected[0] = expected[1] = 5
    expected[24] = 7
    expect(Array.from(readWav(track!.wav)!.samples)).toEqual(expected)
  })

  test("una clip MAI a 24 kHz e una Piper a 22,05 kHz nella stessa ripresa: nessuna scartata, traccia 24 kHz mono 16 bit", () => {
    const track = buildVoiceTrack(
      [
        { at: 0, wav: flat(24000, 240, 500) },
        // 100 ms of Piper: 2205 samples become 2400.
        { at: 100, wav: flat(22050, 2205, 1000) },
      ],
      300,
    )
    expect(track?.skipped).toBe(0)
    const view = new DataView(track!.wav)
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(34, true)).toBe(16)
    const pcm = readWav(track!.wav)!
    expect(pcm.sampleRate).toBe(24000)
    expect(pcm.channels).toBe(1)
    expect(pcm.samples.length).toBe(7200)
    expect(pcm.samples[0]).toBe(500)
    expect(pcm.samples[239]).toBe(500)
    expect(pcm.samples[240]).toBe(0)
    expect(pcm.samples.slice(2400, 4800).every((s) => s === 1000)).toBe(true)
    expect(pcm.samples[4800]).toBe(0)
  })

  test("una clip più lenta è interpolata tra i suoi campioni, una stereo ridotta a un canale con la media", () => {
    const slow = buildVoiceTrack([{ at: 0, wav: tone(12000, [0, 1000, 2000]) }], 0.25)
    expect(Array.from(readWav(slow!.wav)!.samples)).toEqual([0, 500, 1000, 1500, 2000, 2000])

    const stereo = buildVoiceTrack([{ at: 0, wav: tone(24000, [100, 300, -100, -300], 2) }], 0.125)
    const pcm = readWav(stereo!.wav)!
    expect(pcm.channels).toBe(1)
    expect(Array.from(pcm.samples)).toEqual([200, -200, 0])
  })

  test("la traccia dura quanto la ripresa: una clip oltre la fine viene tagliata", () => {
    // 10 ms of take is 240 samples; a Piper clip 5 ms in has room for 120 of its 2400.
    const track = buildVoiceTrack([{ at: 5, wav: flat(22050, 2205, 1000) }], 10)
    const samples = readWav(track!.wav)!.samples
    expect(samples.length).toBe(240)
    expect(samples.slice(0, 120).every((s) => s === 0)).toBe(true)
    expect(samples.slice(120).every((s) => s === 1000)).toBe(true)
  })

  test("frasi sovrapposte in formati diversi si sommano con il taglio a 16 bit, come si sono sentite", () => {
    const track = buildVoiceTrack(
      [
        { at: 0, wav: tone(24000, [30000, -30000, -30000]) },
        { at: 0, wav: flat(22050, 2205, 30000) },
        { at: 0, wav: flat(22050, 2205, -30000) },
      ],
      1,
    )
    expect(track?.skipped).toBe(0)
    // 30000 + 30000 - 30000, then -30000 + 30000 - 30000: summed as they come, clipped at each step.
    const samples = readWav(track!.wav)!.samples
    expect(samples[0]).toBe(2767)
    expect(samples[1]).toBe(-30000)
    expect(samples[3]).toBe(0)
  })

  test("un formato che non è PCM a 16 bit resta scartato e contato, anche accanto a clip da ricampionare", () => {
    const track = buildVoiceTrack(
      [
        { at: 0, wav: tone(24000, [1]) },
        { at: 0, wav: flat(22050, 2205, 2) },
        { at: 0, wav: bent(20, 3) }, // IEEE float
        { at: 0, wav: bent(34, 8) }, // 8-bit
        { at: 0, wav: bent(20, 0x55) }, // MP3 inside a WAV
        { at: 0, wav: bent(24, 0, 32) }, // no sample rate
        { at: 0, wav: new ArrayBuffer(10) }, // not a WAV at all
      ],
      1,
    )
    expect(track?.skipped).toBe(5)
    const pcm = readWav(track!.wav)!
    expect(pcm.sampleRate).toBe(24000)
    expect(pcm.samples[0]).toBe(3)
  })

  test("no voice at all gives no track", () => {
    expect(buildVoiceTrack([], 1000)).toBeUndefined()
    expect(buildVoiceTrack([{ at: 0, wav: new ArrayBuffer(4) }], 1000)).toBeUndefined()
  })
})
