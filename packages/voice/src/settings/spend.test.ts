import { describe, expect, test } from "bun:test"
import { addSpend, createSpendTally, dayOf, emptyDay, formatSpendCost, readDaySpend, VOICE_SPEND_STORAGE_KEY } from "./spend"

const noon = new Date(2026, 8, 17, 12, 0, 0).getTime()
const nextDay = noon + 24 * 60 * 60_000

describe("what listening spent today", () => {
  test("counts each request and its cost, and starts from nothing on a new day", () => {
    let spend = emptyDay(dayOf(noon))
    spend = addSpend(spend, noon, 0.0000556)
    spend = addSpend(spend, noon, 0.0000556)
    expect(spend.calls).toBe(2)
    expect(spend.cost).toBeCloseTo(0.0001112, 8)
    const tomorrow = addSpend(spend, nextDay, 0.0000556)
    expect(tomorrow.calls).toBe(1)
    expect(tomorrow.day).toBe(dayOf(nextDay))
    // A request whose cost the service did not say is still a request.
    expect(addSpend(spend, noon, undefined).cost).toBeCloseTo(spend.cost, 8)
  })

  test("yesterday's total, or a broken one, is not shown as today's", () => {
    expect(readDaySpend(JSON.stringify({ day: dayOf(noon), calls: 4, cost: 0.2 }), noon)).toMatchObject({ calls: 4, cost: 0.2 })
    expect(readDaySpend(JSON.stringify({ day: dayOf(noon), calls: 4, cost: 0.2 }), nextDay).calls).toBe(0)
    expect(readDaySpend("non è json", noon).calls).toBe(0)
    expect(readDaySpend(JSON.stringify({ day: dayOf(noon), calls: -2, cost: "tanto" }), noon)).toMatchObject({ calls: 0, cost: 0 })
    expect(readDaySpend(null, noon).day).toBe(dayOf(noon))
  })

  test("it survives a restart, and a storage that refuses does not stop it", () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    } as unknown as Storage
    const tally = createSpendTally(storage, noon)
    tally.add(noon, 0.0000556)
    tally.add(noon, 0.0000556)
    expect(JSON.parse(store.get(VOICE_SPEND_STORAGE_KEY)!)).toMatchObject({ calls: 2 })
    expect(createSpendTally(storage, noon).today(noon).calls).toBe(2)
    expect(createSpendTally(storage, nextDay).today(nextDay).calls).toBe(0)

    const refused = {
      getItem: () => {
        throw new Error("no")
      },
      setItem: () => {
        throw new Error("no")
      },
    } as unknown as Storage
    const offline = createSpendTally(refused, noon)
    expect(offline.add(noon, 0.0000556).calls).toBe(1)
    expect(createSpendTally(null, noon).add(noon, undefined).calls).toBe(1)
  })
})

describe("the day's cost as money", () => {
  test("two decimals, and less than a cent says so rather than reading as free", () => {
    expect(formatSpendCost(0, "en-US")).toBe("$0.00")
    expect(formatSpendCost(0.0000556, "en-US")).toBe("< $0.01")
    expect(formatSpendCost(0.024, "en-US")).toBe("$0.02")
    expect(formatSpendCost(1.5, "en-US")).toBe("$1.50")
  })
})
