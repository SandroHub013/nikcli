import { describe, expect, test } from "bun:test"
import { FAMILIES, MAX_MS, measure, PEAK, toWav } from "../../../tui/script/sound-synth"

/* The candidate notification sounds are computed, not sampled: check what makes a sound urtante on every one. */
describe("the candidate sounds", () => {
  test("there are at least five families, each with «done» and «need an answer»", () => {
    expect(FAMILIES.length).toBeGreaterThanOrEqual(5)
    expect(new Set(FAMILIES.map((f) => f.id)).size).toBe(FAMILIES.length)
  })

  for (const family of FAMILIES) {
    for (const kind of ["idle", "permission"] as const) {
      test(`${family.id}-${kind}: short, soft, never clipping, at the set peak, starting and ending at silence`, () => {
        const wav = toWav(family.render(kind))
        const m = measure(wav)
        expect(m.ms).toBeLessThanOrEqual(MAX_MS)
        expect(m.ms).toBeGreaterThan(100)
        expect(m.clipped).toBe(0)
        expect(m.peakDb).toBeCloseTo(20 * Math.log10(PEAK), 0)
        expect(m.peakDb).toBeLessThan(-6)
        expect(m.above4k).toBeLessThan(1)
        const dv = new DataView(wav.buffer)
        expect(Math.abs(dv.getInt16(44, true))).toBeLessThan(200)
        expect(Math.abs(dv.getInt16(wav.length - 2, true))).toBeLessThan(200)
      })
    }

    test(`${family.id}: «done» and «need an answer» are different sounds`, () => {
      const a = toWav(family.render("idle"))
      const b = toWav(family.render("permission"))
      expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).not.toBe(0)
    })
  }

  test("the measurer sees what is wrong with a clipped, loud, long sound", () => {
    const n = 44100
    const wav = new Uint8Array(44 + n * 2)
    const dv = new DataView(wav.buffer)
    "RIFF".split("").forEach((c, i) => (wav[i] = c.charCodeAt(0)))
    "WAVEfmt ".split("").forEach((c, i) => (wav[8 + i] = c.charCodeAt(0)))
    dv.setUint32(16, 16, true)
    dv.setUint16(20, 1, true)
    dv.setUint16(22, 1, true)
    dv.setUint32(24, 44100, true)
    dv.setUint16(34, 16, true)
    "data".split("").forEach((c, i) => (wav[36 + i] = c.charCodeAt(0)))
    dv.setUint32(40, n * 2, true)
    for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, i % 100 < 50 ? 32767 : -32768, true)
    const m = measure(wav)
    expect(m.ms).toBe(1000)
    expect(m.peakDb).toBe(0)
    expect(m.clipped).toBe(n)
  })
})
