import { afterEach, beforeEach, expect, test, jest } from "bun:test"
import { HIDDEN_WATCH_MS, every, watchDue } from "./every"

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

test("ticks on the delay while visible", async () => {
  let count = 0
  const stop = every(100, () => count++, { isHidden: () => false, onVisible: () => () => {} })
  jest.advanceTimersByTime(350)
  await flush()
  stop()
  expect(count).toBeGreaterThanOrEqual(1)
  expect(count).toBeLessThanOrEqual(3)
})

test("pauses while hidden and catches up when shown", async () => {
  let hidden = true
  let show: () => void = () => {}
  let count = 0
  const stop = every(100, () => count++, {
    isHidden: () => hidden,
    onVisible: (listener) => {
      show = listener
      return () => {}
    },
  })
  jest.advanceTimersByTime(1000)
  await flush()
  expect(count).toBe(0)
  hidden = false
  show()
  await flush()
  expect(count).toBe(1)
  stop()
})

test("a slower delay keeps it going while hidden", async () => {
  let count = 0
  const stop = every(100, () => count++, { whenHidden: 1000, isHidden: () => true, onVisible: () => () => {} })
  jest.advanceTimersByTime(900)
  await flush()
  expect(count).toBe(0)
  jest.advanceTimersByTime(200)
  await flush()
  expect(count).toBe(1)
  stop()
})

test("stops for good", async () => {
  let count = 0
  const stop = every(100, () => count++, { isHidden: () => false, onVisible: () => () => {} })
  stop()
  jest.advanceTimersByTime(1000)
  await flush()
  expect(count).toBe(0)
})

test("watchDue: every pass while visible, once every 5 s while hidden (P1-C1)", () => {
  expect(HIDDEN_WATCH_MS).toBe(5_000)
  expect(watchDue(false, 1_000, 900)).toBe(true)
  expect(watchDue(true, 1_000, 0)).toBe(false)
  expect(watchDue(true, 4_999, 0)).toBe(false)
  expect(watchDue(true, 5_000, 0)).toBe(true)
  // Back in view: the next pass watches at once, whenever the last one was.
  expect(watchDue(false, 5_001, 5_000)).toBe(true)
})
