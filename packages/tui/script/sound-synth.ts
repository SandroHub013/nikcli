/**
 * Synthesises the candidate notification sounds for ragu, and measures them.
 *
 *   bun packages/tui/script/sound-synth.ts <outDir>
 *
 * Writes <family>-idle.wav («I'm done») and <family>-permission.wav («I need an answer from you») for each family,
 * and measure.json with duration, peak, RMS, clipped samples and the share of energy above 4 kHz of every file, the
 * sounds ragu plays today included, for comparison. Nothing is sampled from anywhere: every sample is computed here,
 * so there is no licence to carry. Mono, 44.1 kHz, 16 bit, under 400 ms, a soft attack, peak at PEAK.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const RATE = 44100
/** Linear peak of every new sound: about -9 dBFS, never clipping. The sounds of today peak at 0 dBFS and clip. */
export const PEAK = 0.35
export const MAX_MS = 400

type Voice = (t: number) => number

/** Seconds of silence, then `voice`, summed into `buf` at `at` seconds. */
function mixAt(buf: Float32Array, at: number, dur: number, voice: Voice, gain = 1) {
  const start = Math.round(at * RATE)
  const n = Math.round(dur * RATE)
  for (let i = 0; i < n && start + i < buf.length; i++) buf[start + i] += gain * voice(i / RATE)
}

const TAU = Math.PI * 2
/** A raised-cosine attack, so no sound starts with a click. */
const attack = (t: number, ms: number) => (t >= ms / 1000 ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * t) / (ms / 1000)))
const decay = (t: number, tau: number) => Math.exp(-t / tau)

function partials(freq: number, parts: Array<[ratio: number, amp: number, tau: number]>, atkMs: number): Voice {
  return (t) => {
    let sum = 0
    for (const [ratio, amp, tau] of parts) sum += amp * Math.sin(TAU * freq * ratio * t) * decay(t, tau)
    return sum * attack(t, atkMs)
  }
}

/** One-pole low-pass, to take the edge off. */
function lowpass(buf: Float32Array, cutoff: number) {
  const a = 1 - Math.exp((-TAU * cutoff) / RATE)
  let y = 0
  for (let i = 0; i < buf.length; i++) buf[i] = y += a * (buf[i]! - y)
}

/** A bubble: a sine whose pitch rises as it decays, like the one that comes up in a simmering pot. */
function bubble(f0: number): Voice {
  let phase = 0
  let last = 0
  return (t) => {
    const f = f0 * (1 + 1.4 * (1 - Math.exp(-t / 0.035)))
    phase += (TAU * f) * Math.max(0, t - last)
    last = t
    return Math.sin(phase) * decay(t, 0.05) * attack(t, 5)
  }
}

/** A wooden knock: a few damped modes and a very short, dull burst of noise. */
function knock(f: number, seed: number): Voice {
  let s = seed
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff) * 2 - 1
  let lp = 0
  const body = partials(f, [[1, 1, 0.045], [2.3, 0.4, 0.03], [3.9, 0.15, 0.016]], 3)
  return (t) => {
    lp += 0.2 * (rnd() - lp)
    return body(t) + 0.35 * lp * decay(t, 0.006)
  }
}

type Family = {
  id: string
  name: string
  about: string
  render(kind: "idle" | "permission"): Float32Array
}

function buffer(ms: number) {
  return new Float32Array(Math.round((ms / 1000) * RATE))
}

export const FAMILIES: Family[] = [
  {
    id: "bolla",
    name: "La bolla del ragù",
    about: "Una bolla che sale e scoppia piano, come nella pentola che sobbolle. Calda e senza spigoli: la più «cucina» di tutte.",
    render(kind) {
      const buf = buffer(380)
      if (kind === "idle") mixAt(buf, 0, 0.3, bubble(250))
      else {
        mixAt(buf, 0, 0.22, bubble(300))
        mixAt(buf, 0.15, 0.22, bubble(390))
      }
      lowpass(buf, 2200)
      return buf
    },
  },
  {
    id: "mestolo",
    name: "Il mestolo di legno sul bordo",
    about: "Un colpo secco ma ovattato, di legno. Uno: ho finito. Due, che salgono: mi serve una risposta.",
    render(kind) {
      const buf = buffer(380)
      if (kind === "idle") mixAt(buf, 0, 0.25, knock(360, 7))
      else {
        mixAt(buf, 0, 0.2, knock(360, 7))
        mixAt(buf, 0.14, 0.24, knock(470, 11))
      }
      lowpass(buf, 3200)
      return buf
    },
  },
  {
    id: "marimba",
    name: "Due note di marimba",
    about: "Due note di legno morbide. Scendono quando ho finito, salgono quando ti chiedo qualcosa: si distinguono anche senza guardare.",
    render(kind) {
      const buf = buffer(390)
      const note = (f: number) => partials(f, [[1, 1, 0.09], [4, 0.22, 0.03], [10, 0.05, 0.012]], 3)
      const [a, b] = kind === "idle" ? [784, 659.25] : [659.25, 880]
      mixAt(buf, 0, 0.26, note(a))
      mixAt(buf, 0.135, 0.255, note(b))
      lowpass(buf, 4200)
      return buf
    },
  },
  {
    id: "coperchio",
    name: "Il coperchio che tintinna piano",
    about: "Un tintinnio di metallo leggero, con pochi armonici acuti e spenti. Uno solo: finito. Due ravvicinati: ti serve una risposta.",
    render(kind) {
      const buf = buffer(380)
      const hit = (f: number) =>
        partials(f, [[1, 1, 0.1], [1.006, 0.6, 0.1], [2.76, 0.3, 0.05], [5.4, 0.07, 0.025]], 4)
      if (kind === "idle") mixAt(buf, 0, 0.3, hit(700))
      else {
        mixAt(buf, 0, 0.2, hit(700))
        mixAt(buf, 0.12, 0.26, hit(790))
      }
      lowpass(buf, 3600)
      return buf
    },
  },
  {
    id: "kalimba",
    name: "Una kalimba",
    about: "Lamelle pizzicate, rotonde. Due note che scendono per «finito», tre che salgono, come un arpeggio, per «rispondimi».",
    render(kind) {
      const buf = buffer(390)
      const tine = (f: number) => partials(f, [[1, 1, 0.1], [5.4, 0.09, 0.02]], 2.5)
      if (kind === "idle") {
        mixAt(buf, 0, 0.26, tine(587.33))
        mixAt(buf, 0.13, 0.26, tine(440))
      } else {
        mixAt(buf, 0, 0.17, tine(440))
        mixAt(buf, 0.1, 0.17, tine(587.33))
        mixAt(buf, 0.2, 0.18, tine(739.99))
      }
      lowpass(buf, 4000)
      return buf
    },
  },
]

/** 16-bit mono WAV, fade-out on the last 12 ms, peak at PEAK. */
export function toWav(buf: Float32Array): Uint8Array {
  let peak = 0
  for (const v of buf) peak = Math.max(peak, Math.abs(v))
  const gain = peak > 0 ? PEAK / peak : 1
  const fade = Math.round(0.012 * RATE)
  const out = new Uint8Array(44 + buf.length * 2)
  const dv = new DataView(out.buffer)
  const ascii = (at: number, text: string) => [...text].forEach((c, i) => (out[at + i] = c.charCodeAt(0)))
  ascii(0, "RIFF")
  dv.setUint32(4, 36 + buf.length * 2, true)
  ascii(8, "WAVEfmt ")
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true)
  dv.setUint16(22, 1, true)
  dv.setUint32(24, RATE, true)
  dv.setUint32(28, RATE * 2, true)
  dv.setUint16(32, 2, true)
  dv.setUint16(34, 16, true)
  ascii(36, "data")
  dv.setUint32(40, buf.length * 2, true)
  for (let i = 0; i < buf.length; i++) {
    const tail = buf.length - i
    const f = tail < fade ? tail / fade : 1
    dv.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, buf[i]! * gain * f)) * 32767), true)
  }
  return out
}

export type Measure = {
  ms: number
  peakDb: number
  rmsDb: number
  clipped: number
  /** Share of the energy above 4 kHz, in percent: where a sound turns shrill. */
  above4k: number
  /** Where the energy sits on average, in Hz: lower is rounder. */
  centroidHz: number
  channels: number
}

function fft(re: Float64Array, im: Float64Array) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j]!, re[i]!]
      ;[im[i], im[j]] = [im[j]!, im[i]!]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-TAU) / len
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k)
        const wi = Math.sin(ang * k)
        const a = i + k
        const b = a + len / 2
        const xr = re[b]! * wr - im[b]! * wi
        const xi = re[b]! * wi + im[b]! * wr
        re[b] = re[a]! - xr
        im[b] = im[a]! - xi
        re[a] = re[a]! + xr
        im[a] = im[a]! + xi
      }
    }
  }
}

/** Reads a 16-bit PCM WAV (any rate, mono or stereo) and measures it. */
export function measure(wav: Uint8Array): Measure {
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  const channels = dv.getUint16(22, true)
  const rate = dv.getUint32(24, true)
  let at = 12
  let dataAt = 0
  let dataLen = 0
  while (at + 8 <= wav.length) {
    const id = String.fromCharCode(wav[at]!, wav[at + 1]!, wav[at + 2]!, wav[at + 3]!)
    const len = dv.getUint32(at + 4, true)
    if (id === "data") {
      dataAt = at + 8
      dataLen = Math.min(len, wav.length - dataAt)
      break
    }
    at += 8 + len
  }
  const frames = Math.floor(dataLen / (2 * channels))
  const mono = new Float64Array(frames)
  let peak = 0
  let sq = 0
  let clipped = 0
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (let c = 0; c < channels; c++) {
      const raw = dv.getInt16(dataAt + (i * channels + c) * 2, true)
      if (raw >= 32767 || raw <= -32768) clipped++
      sum += raw / 32768
    }
    mono[i] = sum / channels
    peak = Math.max(peak, Math.abs(mono[i]!))
    sq += mono[i]! * mono[i]!
  }
  let n = 1
  while (n < frames) n <<= 1
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  re.set(mono)
  fft(re, im)
  let total = 0
  let high = 0
  let weighted = 0
  const bin = rate / n
  for (let k = 1; k < n / 2; k++) {
    const e = re[k]! * re[k]! + im[k]! * im[k]!
    total += e
    weighted += e * k * bin
    if (k * bin >= 4000) high += e
  }
  const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity)
  return {
    ms: Math.round((frames / rate) * 1000),
    peakDb: Math.round(db(peak) * 10) / 10,
    rmsDb: Math.round(db(Math.sqrt(sq / Math.max(1, frames))) * 10) / 10,
    clipped,
    above4k: Math.round((total > 0 ? (high / total) * 100 : 0) * 100) / 100,
    centroidHz: Math.round(total > 0 ? weighted / total : 0),
    channels,
  }
}

if (import.meta.main) {
  const out = process.argv[2]
  if (!out) throw new Error("usage: bun sound-synth.ts <outDir>")
  mkdirSync(out, { recursive: true })
  const report: Record<string, Measure> = {}
  for (const family of FAMILIES) {
    for (const kind of ["idle", "permission"] as const) {
      const wav = toWav(family.render(kind))
      const name = `${family.id}-${kind}`
      const m = measure(wav)
      if (m.ms > MAX_MS) throw new Error(`${name} lasts ${m.ms} ms, over ${MAX_MS}`)
      if (m.clipped > 0) throw new Error(`${name} clips`)
      writeFileSync(join(out, `${name}.wav`), wav)
      report[name] = m
    }
  }
  // What ragu plays today, for comparison: idle rotates pulse-a/b/c, a permission is the same pulse, louder.
  const assets = join(import.meta.dir, "../src/asset")
  for (const [name, file] of [["oggi-pulse-a", "pulse-a.wav"], ["oggi-pulse-b", "pulse-b.wav"], ["oggi-pulse-c", "pulse-c.wav"]] as const) {
    const bytes = new Uint8Array(readFileSync(join(assets, file)))
    writeFileSync(join(out, `${name}.wav`), bytes)
    report[name] = measure(bytes)
  }
  writeFileSync(join(out, "measure.json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
