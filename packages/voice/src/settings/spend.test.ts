import { describe, expect, test } from "bun:test"
import {
  addSpend,
  createSpendTally,
  dayOf,
  emptyDay,
  formatSpendCost,
  readDaySpend,
  VOICE_SPEND_STORAGE_KEY,
} from "./spend"

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
    expect(readDaySpend(JSON.stringify({ day: dayOf(noon), calls: 4, cost: 0.2 }), noon)).toMatchObject({
      calls: 4,
      cost: 0.2,
    })
    expect(readDaySpend(JSON.stringify({ day: dayOf(noon), calls: 4, cost: 0.2 }), nextDay).calls).toBe(0)
    expect(readDaySpend("non è json", noon).calls).toBe(0)
    expect(readDaySpend(JSON.stringify({ day: dayOf(noon), calls: -2, cost: "tanto" }), noon)).toMatchObject({
      calls: 0,
      cost: 0,
    })
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

describe("la spesa della voce delle risposte nello stesso giorno", () => {
  const at = new Date(2026, 9, 5, 12).getTime()

  test("una risposta prenota prima della richiesta, nel giorno e nella sua parte", () => {
    const tally = createSpendTally(null, at)
    const day = tally.addReply(at, 0.0006)
    expect(day.calls).toBe(1)
    expect(day.cost).toBeCloseTo(0.0006)
    expect(day.replyCalls).toBe(1)
    expect(day.replyCost).toBeCloseTo(0.0006)
  })

  test("la regolazione corregge della differenza, e lo stesso id due volte non cambia niente", () => {
    const tally = createSpendTally(null, at)
    tally.addReply(at, 0.0006)
    const once = tally.settleReply("gen-1", at, 0.0004 - 0.0006, at)
    expect(once.replyCost).toBeCloseTo(0.0004)
    expect(once.cost).toBeCloseTo(0.0004)
    const twice = tally.settleReply("gen-1", at, 0.0004 - 0.0006, at)
    expect(twice.replyCost).toBeCloseTo(0.0004)
    expect(twice.cost).toBeCloseTo(0.0004)
  })

  test("una regolazione di ieri non tocca oggi", () => {
    const tally = createSpendTally(null, at)
    tally.addReply(at, 0.001)
    const yesterday = at - 24 * 3_600_000
    expect(tally.settleReply("gen-old", yesterday, -0.001, at).replyCost).toBeCloseTo(0.001)
  })

  test("ascolto e risposte intrecciati sullo stesso tally non si sovrascrivono", () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    } as unknown as Storage
    const tally = createSpendTally(storage, at)
    tally.add(at, undefined)
    tally.addReply(at, 0.002)
    tally.addCost(at, 0.01)
    tally.addReply(at, 0.003)
    tally.settleReply("gen-a", at, -0.001, at)
    const day = tally.today(at)
    expect(day.calls).toBe(3)
    expect(day.cost).toBeCloseTo(0.014)
    expect(day.replyCalls).toBe(2)
    expect(day.replyCost).toBeCloseTo(0.004)
    // Riletto dallo storage, come al prossimo avvio.
    const again = createSpendTally(storage, at).today(at)
    expect(again).toEqual(day)
  })

  test("chi ascolta il tally sente anche le scritture dell'altro", () => {
    const tally = createSpendTally(null, at)
    const seen: number[] = []
    tally.onChange((day) => seen.push(day.calls))
    tally.add(at, undefined)
    tally.addReply(at, 0.001)
    expect(seen).toEqual([1, 2])
  })
})
