import { afterEach, describe, expect, test } from "bun:test"
import {
  cycleQuality,
  loadRecordDir,
  loadRecordMic,
  loadRecordQuality,
  RECORD_DIR_KEY,
  RECORD_MIC_KEY,
  RECORD_QUALITY_KEY,
  saveRecordDir,
  saveRecordMic,
  saveRecordQuality,
} from "./prefs"
import { DEFAULT_QUALITY, QUALITY_LEVELS } from "./recording"

afterEach(() => {
  localStorage.removeItem(RECORD_DIR_KEY)
  localStorage.removeItem(RECORD_QUALITY_KEY)
  localStorage.removeItem(RECORD_MIC_KEY)
})

describe("record prefs", () => {
  test("without saved values the defaults stand: no folder, alta quality, microphone off", () => {
    expect(loadRecordDir()).toBeUndefined()
    expect(loadRecordQuality()).toBe(DEFAULT_QUALITY)
    expect(loadRecordMic()).toBe(false)
  })

  test("a saved value round-trips, and an unknown quality falls back to the default", () => {
    saveRecordDir("/tmp/takes")
    saveRecordQuality("leggera")
    saveRecordMic(true)

    expect(loadRecordDir()).toBe("/tmp/takes")
    expect(loadRecordQuality()).toBe("leggera")
    expect(loadRecordMic()).toBe(true)

    localStorage.setItem(RECORD_QUALITY_KEY, "inventata")
    expect(loadRecordQuality()).toBe(DEFAULT_QUALITY)
    localStorage.setItem(RECORD_MIC_KEY, "off")
    expect(loadRecordMic()).toBe(false)
  })

  test("the palette cycle walks every level in order and wraps around", () => {
    const order = QUALITY_LEVELS.map((level) => level.id)
    let current = order[0]!
    for (let i = 1; i < order.length; i++) {
      current = cycleQuality(current)
      expect(current).toBe(order[i])
    }
    // Wrap: after the last level comes the first one again.
    expect(cycleQuality(current)).toBe(order[0])
  })
})
