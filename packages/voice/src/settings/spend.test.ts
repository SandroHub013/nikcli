import { describe, expect, test } from "bun:test"
import {
  addReplySpend,
  addSpend,
  addStreamSpend,
  createSpendTally,
  dayOf,
  emptyDay,
  formatSpendCost,
  readDaySpend,
  streamCapReached,
  streamCostOf,
  streamSecondsOf,
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

describe("la spesa della trascrizione in tempo reale", () => {
  const memory = () => {
    const store = new Map<string, string>()
    return {
      store,
      storage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
      } as unknown as Storage,
    }
  }

  test("si conta sui secondi mandati: 32 000 byte sono un secondo, un'ora costa venti centesimi", () => {
    expect(streamSecondsOf(32_000)).toBe(1)
    expect(streamSecondsOf(16_000)).toBe(0.5)
    expect(streamSecondsOf(-5)).toBe(0)
    expect(streamCostOf(3600)).toBeCloseTo(0.2, 10)
    expect(streamCostOf(60)).toBeCloseTo(0.2 / 60, 10)
    expect(streamCostOf(Number.NaN)).toBe(0)
  })

  test("i secondi e il costo entrano nel giorno, a parte: calls, cost e replyCost non si muovono", () => {
    let spend = emptyDay(dayOf(noon))
    spend = addSpend(spend, noon, 0.01)
    spend = addReplySpend(spend, noon, 0.002)
    const before = { calls: spend.calls, cost: spend.cost, replyCalls: spend.replyCalls, replyCost: spend.replyCost }
    spend = addStreamSpend(spend, noon, 90)
    spend = addStreamSpend(spend, noon, 30)
    expect(spend.streamSeconds).toBe(120)
    expect(spend.streamCost).toBeCloseTo(120 * 0.2 / 3600, 10)
    expect({ calls: spend.calls, cost: spend.cost, replyCalls: spend.replyCalls, replyCost: spend.replyCost }).toEqual(
      before,
    )
  })

  test("un secondo zero, o negativo, non cambia niente; un giorno nuovo riparte da zero", () => {
    const spend = addStreamSpend(emptyDay(dayOf(noon)), noon, 10)
    expect(addStreamSpend(spend, noon, 0)).toBe(spend)
    expect(addStreamSpend(spend, noon, -3)).toBe(spend)
    const tomorrow = addStreamSpend(spend, nextDay, 5)
    expect(tomorrow.day).toBe(dayOf(nextDay))
    expect(tomorrow.streamSeconds).toBe(5)
  })

  test("un giorno scritto prima dello streaming si legge senza i campi nuovi, e quelli nuovi si rileggono", () => {
    const old = readDaySpend(JSON.stringify({ day: dayOf(noon), calls: 4, cost: 0.2 }), noon)
    expect(old.streamSeconds).toBeUndefined()
    expect(old.streamCost).toBeUndefined()
    const written = readDaySpend(
      JSON.stringify({ day: dayOf(noon), calls: 0, cost: 0, streamSeconds: 600, streamCost: 0.0333 }),
      noon,
    )
    expect(written.streamSeconds).toBe(600)
    expect(written.streamCost).toBeCloseTo(0.0333, 6)
    // Un valore rotto vale zero e non si mostra.
    const broken = readDaySpend(
      JSON.stringify({ day: dayOf(noon), calls: 0, cost: 0, streamSeconds: "tanti", streamCost: -1 }),
      noon,
    )
    expect(broken.streamSeconds).toBeUndefined()
    expect(broken.streamCost).toBeUndefined()
    // E ieri non è oggi.
    expect(
      readDaySpend(JSON.stringify({ day: dayOf(noon), streamSeconds: 600, streamCost: 0.03 }), nextDay).streamSeconds,
    ).toBeUndefined()
  })

  test("il tetto guarda solo lo streaming: la spesa di OpenRouter e delle risposte non lo consuma", () => {
    // Un giorno pieno di risposte a voce e di frasi sulla sonda del nome, e nemmeno un secondo di streaming.
    let spend = emptyDay(dayOf(noon))
    spend = addSpend(spend, noon, 0.4)
    spend = addReplySpend(spend, noon, 0.3)
    expect(spend.cost).toBeGreaterThan(0.5)
    expect(streamCapReached(spend, 0.5)).toBe(false)
    // Mezz'ora di streaming: 0,10 $.
    spend = addStreamSpend(spend, noon, 1800)
    expect(streamCapReached(spend, 0.5)).toBe(false)
    expect(streamCapReached(spend, 0.1)).toBe(true)
    expect(streamCapReached(spend, 0.1000001)).toBe(false)
  })

  test("un tetto a zero è già raggiunto: lo streaming è spento", () => {
    expect(streamCapReached(emptyDay(dayOf(noon)), 0)).toBe(true)
    expect(streamCapReached(emptyDay(dayOf(noon)), 0.5)).toBe(false)
  })

  test("il tetto si raggiunge nel giorno e si libera il giorno dopo", () => {
    const tally = createSpendTally(null, noon)
    tally.addStream(noon, 3600 * 3) // tre ore: 0,60 $
    expect(streamCapReached(tally.today(noon), 0.5)).toBe(true)
    expect(streamCapReached(tally.today(nextDay), 0.5)).toBe(false)
  })

  test("il tally scrive i secondi, li ritrova al prossimo avvio e lo dice a chi ascolta", () => {
    const { storage, store } = memory()
    const tally = createSpendTally(storage, noon)
    const seen: (number | undefined)[] = []
    tally.onChange((day) => seen.push(day.streamSeconds))
    tally.addStream(noon, 12)
    tally.addStream(noon, 8)
    expect(seen).toEqual([12, 20])
    expect(JSON.parse(store.get(VOICE_SPEND_STORAGE_KEY) ?? "{}")).toMatchObject({ streamSeconds: 20 })
    expect(createSpendTally(storage, noon).today(noon).streamSeconds).toBe(20)
  })

  test("zero secondi non scrive niente", () => {
    const { storage, store } = memory()
    const tally = createSpendTally(storage, noon)
    tally.addStream(noon, 0)
    expect(store.size).toBe(0)
  })

  test("ascolto, risposte e streaming sullo stesso tally non si sovrascrivono", () => {
    const tally = createSpendTally(null, noon)
    tally.add(noon, undefined)
    tally.addStream(noon, 60)
    tally.addReply(noon, 0.002)
    tally.addStream(noon, 60)
    const day = tally.today(noon)
    expect(day.calls).toBe(2)
    expect(day.replyCalls).toBe(1)
    expect(day.streamSeconds).toBe(120)
  })
})
