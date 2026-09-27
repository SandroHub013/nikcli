import { describe, expect, test } from "bun:test"
import {
  addRoutine,
  checkRoutine,
  createRoutineScheduler,
  dueAt,
  EMPTY_BOOK,
  memoryRoutineStore,
  parseBook,
  planKey,
  reconsent,
  recordResult,
  recordStart,
  routineConsent,
  routineOffer,
  routineProblem,
  routineReadOnly,
  type Routine,
  type RoutineBook,
  type RoutineContext,
} from "./routine"
import { t } from "../i18n"
import { ROUTINE_POLICY } from "./terms"
import { emptyTalk } from "./talk"
import type { Turn, TurnResult } from "./turn"

/** Local time, like the routines: 26 September 2026 at `hours`:`minutes`. */
const at = (hours: number, minutes = 0, day = 26) => new Date(2026, 8, day, hours, minutes).getTime()
const HOUR = 3_600_000

const claudePlan: RoutineContext = { runner: "claude", model: "sonnet", account: { mode: "plan" } }
const claudeKey: RoutineContext = { runner: "claude", model: "sonnet", account: { mode: "key", key: "lavoro" } }
const nikcliFree: RoutineContext = { runner: "nikcli", model: "openrouter/nex-agi/nex-n2.5-mini:free" }
const nikcliPaid: RoutineContext = { runner: "nikcli", model: "openrouter/openai/gpt-4o" }

async function made(context: RoutineContext, fields: Partial<Routine> = {}): Promise<Routine> {
  const draft = {
    id: fields.id ?? "r1",
    bot: "C:/p/.nikcli/agent/a.md",
    prompt: "riassumi le novità",
    every: { kind: "hours", hours: 1 } as const,
    createdAt: at(8),
    ...fields,
  }
  return { ...draft, consent: fields.consent ?? (await routineConsent(draft, context)) } as Routine
}

describe("B11: the list decides where a routine may exist", () => {
  test("an unknown runner or mode, and grok, get no Routine section", () => {
    expect(routineOffer("gemini", { mode: "plan" }, "x").allowed).toBe(false)
    expect(routineOffer("grok", { mode: "plan" }, "x").allowed).toBe(false)
    expect(routineOffer("grok", { mode: "key", key: "k" }, "x").allowed).toBe(false)
    const codexKey = routineOffer("codex", { mode: "key", key: "k" }, "gpt-5.5")
    expect(codexKey.allowed).toBe(false)
    expect(codexKey.reason).toContain("non riporta un costo")
    expect(codexKey.source).toBeTruthy()
  })

  test("every row the list excludes is refused, and every row it allows carries its source and date", () => {
    for (const row of ROUTINE_POLICY) {
      const account = row.mode === "key" ? ({ mode: "key", key: "k" } as const) : ({ mode: "plan" } as const)
      const model = row.mode === "free" ? "x:free" : "x"
      const offer = routineOffer(row.runner, account, model)
      expect([row.runner, row.mode, offer.allowed]).toEqual([row.runner, row.mode, row.allowed])
      if (row.allowed) {
        expect(offer.source).toBeTruthy()
        expect(offer.checked).toBeTruthy()
        expect(offer.cap).toBeTruthy()
      }
    }
  })

  test("a paid model, or a key, without a spending cap is not saved", () => {
    const draft = { prompt: "x", every: { kind: "hours", hours: 2 } as const }
    expect(routineProblem(draft, routineOffer("nikcli", undefined, nikcliPaid.model))).toContain("tetto di spesa")
    expect(routineProblem(draft, routineOffer("claude", claudeKey.account, "sonnet"))).toContain("tetto di spesa")
    const capped = { ...draft, spend: { perRunUsd: 0.05, perDayUsd: 0.2 } }
    expect(routineProblem(capped, routineOffer("nikcli", undefined, nikcliPaid.model))).toBeUndefined()
    // Within the row's cap, never over it.
    expect(
      routineProblem(
        { ...draft, spend: { perRunUsd: 1, perDayUsd: 2 } },
        routineOffer("claude", claudeKey.account, "sonnet"),
      ),
    ).toContain("0.1")
    expect(routineProblem(draft, routineOffer("nikcli", undefined, nikcliFree.model))).toBeUndefined()
    expect(routineProblem({ ...draft, prompt: "  " }, routineOffer("nikcli", undefined, nikcliFree.model))).toBeTruthy()
  })
})

describe("B11 review, M2: ADE Test spends nothing", () => {
  test("in ADE Test only free models and subscriptions have routines", () => {
    const test = { testBuild: true }
    expect(routineOffer("nikcli", undefined, "openrouter/mario:free", test).allowed).toBe(true)
    expect(routineOffer("claude", { mode: "plan" }, "sonnet", test).allowed).toBe(true)
    expect(routineOffer("codex", { mode: "plan" }, "gpt-5.5", test).allowed).toBe(true)
    const paid = routineOffer("nikcli", undefined, "openrouter/openai/gpt-4o", test)
    expect(paid.allowed).toBe(false)
    expect(paid.reason).toContain("ADE Test")
    expect(routineOffer("claude", { mode: "key", key: "lavoro" }, "sonnet", test).allowed).toBe(false)
    // Outside ADE Test the same rows stay open.
    expect(routineOffer("nikcli", undefined, "openrouter/openai/gpt-4o", { testBuild: false }).allowed).toBe(true)
  })

  test("free is the catalog's word, not only the suffix's", () => {
    const test = { testBuild: true }
    expect(routineOffer("nikcli", undefined, "opencode/mario-free", { ...test, free: true })).toMatchObject({
      allowed: true,
      mode: "free",
    })
    expect(routineOffer("nikcli", undefined, "opencode/mario-free", test).allowed).toBe(false)
  })

  test("a free run is capped at nothing, and one that cost something suspends the routine", async () => {
    const routine = await made(nikcliFree)
    const verdict = checkRoutine(
      addRoutine(EMPTY_BOOK, routine),
      routine,
      { context: nikcliFree, consent: routine.consent, busy: false },
      at(9),
    )
    expect(verdict.kind === "run" && verdict.run.maxCostUsd).toBe(0)
    const key = planKey("nikcli", "free")
    let book = recordStart(addRoutine(EMPTY_BOOK, routine), routine, key, 0, at(9))
    book = recordResult(book, routine, key, { status: "done", costUsd: 0 }, at(9, 1))
    expect(book.logs[routine.id]?.suspended).toBeUndefined()
    book = recordResult(book, routine, key, { status: "error", costUsd: 0.02 }, at(10, 1))
    expect(book.logs[routine.id]?.suspended).toContain("non è gratuito")
    expect(book.logs[routine.id]?.suspended).toContain("0.02 $")
  })
})

describe("B11 review: routines only read", () => {
  test("the consent says so on every runner, nikcli included", () => {
    expect(routineReadOnly("claude")).toBe(true)
    expect(routineReadOnly("codex")).toBe(true)
    expect(routineReadOnly("nikcli")).toBe(true)
    expect(t("bots.routine.consentReadOnly", "Claude Code", "abbonamento", "sonnet")).toContain("sola lettura")
    expect(t("bots.routine.consent", "nikcli", "modello gratuito", "x:free")).not.toContain("sola lettura")
  })
})

describe("B11: the consent", () => {
  test("changing prompt, model, mode, key, schedule or cap changes the hash", async () => {
    const routine = {
      prompt: "riassumi",
      every: { kind: "hours", hours: 2 } as const,
      spend: { perRunUsd: 0.05, perDayUsd: 0.2 },
    }
    const base = await routineConsent(routine, claudeKey)
    expect(base).toMatch(/^[0-9a-f]{64}$/)
    const changed = await Promise.all([
      routineConsent({ ...routine, prompt: "riassumi tutto" }, claudeKey),
      routineConsent(routine, { ...claudeKey, model: "opus" }),
      routineConsent(routine, claudePlan),
      routineConsent(routine, { ...claudeKey, account: { mode: "key", key: "altra" } }),
      routineConsent({ ...routine, every: { kind: "hours", hours: 3 } }, claudeKey),
      routineConsent({ ...routine, spend: { perRunUsd: 0.1, perDayUsd: 0.2 } }, claudeKey),
    ])
    for (const hash of changed) expect(hash).not.toBe(base)
    expect(await routineConsent(routine, claudeKey)).toBe(base)
  })

  test("a changed account suspends the routine until the user agrees again", async () => {
    const routine = await made(claudePlan)
    const book = addRoutine(EMPTY_BOOK, routine)
    const consent = await routineConsent(routine, claudeKey)
    const verdict = checkRoutine(book, routine, { context: claudeKey, consent, busy: false }, at(10))
    expect(verdict.kind).toBe("suspend")
    // Codex with a key is off the list: suspended with the list's reason.
    const codex = checkRoutine(
      book,
      routine,
      { context: { runner: "codex", account: { mode: "key", key: "k" } }, consent, busy: false },
      at(10),
    )
    expect(codex.kind === "suspend" && codex.reason).toContain("non riporta un costo")
    const again = reconsent(book, routine.id, consent)
    expect(checkRoutine(again, again.routines[0]!, { context: claudeKey, consent, busy: false }, at(10)).kind).toBe(
      "suspend",
    )
  })

  test("the book holds names and hashes, never a credential", async () => {
    const routine = await made(claudeKey, { spend: { perRunUsd: 0.05, perDayUsd: 0.2 } })
    const saved = JSON.stringify(addRoutine(EMPTY_BOOK, routine))
    expect(saved).not.toContain("lavoro")
    expect(saved).not.toContain("sk-")
  })
})

describe("B11: the caps, checked before every run", () => {
  test("a Claude plan runs 8 times a day in all, one hour apart, never two at once", async () => {
    let book: RoutineBook = EMPTY_BOOK
    const routines: Routine[] = []
    for (let i = 0; i < 9; i++) {
      const routine = await made(claudePlan, { id: `r${i}` })
      routines.push(routine)
      book = addRoutine(book, routine)
    }
    const consent = routines[0]!.consent
    const key = planKey("claude", "plan")
    for (let i = 0; i < 8; i++) {
      const verdict = checkRoutine(book, routines[i]!, { context: claudePlan, consent, busy: false }, at(10))
      expect(verdict.kind).toBe("run")
      book = recordStart(book, routines[i]!, key, 0, at(10))
    }
    const ninth = checkRoutine(book, routines[8]!, { context: claudePlan, consent, busy: false }, at(10))
    expect(ninth.kind === "wait" && ninth.note).toContain("8")
    // Another run under way: wait, no note.
    const fresh = addRoutine(EMPTY_BOOK, routines[0]!)
    expect(checkRoutine(fresh, routines[0]!, { context: claudePlan, consent, busy: true }, at(10))).toEqual({
      kind: "wait",
    })
    // A daily routine due at 10:00 whose last run was at 9:45 waits for the hour.
    const daily = await made(claudePlan, { every: { kind: "daily", at: "10:00" } })
    let dailyBook = addRoutine(EMPTY_BOOK, daily)
    dailyBook = recordStart(dailyBook, daily, key, 0, at(9, 45))
    expect(
      checkRoutine(dailyBook, daily, { context: claudePlan, consent: daily.consent, busy: false }, at(10, 5)).kind,
    ).toBe("wait")
    expect(
      checkRoutine(dailyBook, daily, { context: claudePlan, consent: daily.consent, busy: false }, at(10, 46)).kind,
    ).toBe("run")
  })

  test("after the plan's limit the routines stop until the next day, with no retry", async () => {
    const routine = await made(claudePlan)
    const key = planKey("claude", "plan")
    let book = recordStart(addRoutine(EMPTY_BOOK, routine), routine, key, 0, at(9))
    book = recordResult(book, routine, key, { status: "error", costUsd: 0, limited: true }, at(9, 1))
    const today = checkRoutine(book, routine, { context: claudePlan, consent: routine.consent, busy: false }, at(15))
    expect(today.kind === "wait" && today.note).toContain("limite")
    const tomorrow = checkRoutine(
      book,
      routine,
      { context: claudePlan, consent: routine.consent, busy: false },
      at(9, 0, 27),
    )
    expect(tomorrow.kind).toBe("run")
  })

  test("money: the day's cap holds, and a run over its own cap suspends the routine", async () => {
    const spend = { perRunUsd: 0.05, perDayUsd: 0.1 }
    const routine = await made(claudeKey, { spend })
    const key = planKey("claude", "key")
    let book = addRoutine(EMPTY_BOOK, routine)
    book = recordStart(book, routine, key, 0, at(9))
    book = recordResult(book, routine, key, { status: "done", costUsd: 0.04 }, at(9, 1))
    book = recordStart(book, routine, key, 0, at(10))
    book = recordResult(book, routine, key, { status: "done", costUsd: 0.04 }, at(10, 1))
    const third = checkRoutine(book, routine, { context: claudeKey, consent: routine.consent, busy: false }, at(11, 5))
    expect(third.kind === "wait" && third.note).toContain("0.10 $")
    // The cap per run goes with the run, to stop it during the turn (review, M1); a plan has none.
    const first = checkRoutine(
      addRoutine(EMPTY_BOOK, routine),
      routine,
      { context: claudeKey, consent: routine.consent, busy: false },
      at(9),
    )
    expect(first.kind === "run" && first.run).toEqual({ maxCostUsd: 0.05 })
    const plan = await made(claudePlan)
    const planRun = checkRoutine(
      addRoutine(EMPTY_BOOK, plan),
      plan,
      { context: claudePlan, consent: plan.consent, busy: false },
      at(9),
    )
    expect(planRun.kind === "run" && planRun.run).toEqual({})
    book = recordResult(book, routine, key, { status: "done", costUsd: 0.07 }, at(11, 6))
    expect(book.logs[routine.id]?.suspended).toContain("0.07 $")
    expect(checkRoutine(book, routine, { context: claudeKey, consent: routine.consent, busy: false }, at(20))).toEqual({
      kind: "wait",
    })
  })

  test("a paid nikcli routine saved without a cap never runs", async () => {
    const routine = await made(nikcliPaid)
    const verdict = checkRoutine(
      addRoutine(EMPTY_BOOK, routine),
      routine,
      { context: nikcliPaid, consent: routine.consent, busy: false },
      at(10),
    )
    expect(verdict.kind === "suspend" && verdict.reason).toContain("tetto di spesa")
  })

  test("with ADE closed for 10 hours, one run on opening, and it says what was missed", async () => {
    const routine = await made(nikcliFree)
    const key = planKey("nikcli", "free")
    let book = recordStart(addRoutine(EMPTY_BOOK, routine), routine, key, 0, at(8))
    expect(dueAt(routine, book.logs[routine.id], at(18))).toEqual({ due: true, missed: 9 })
    const verdict = checkRoutine(book, routine, { context: nikcliFree, consent: routine.consent, busy: false }, at(18))
    expect(verdict).toMatchObject({ kind: "run", missed: 9 })
    book = recordStart(book, routine, key, 9, at(18))
    expect(book.logs[routine.id]?.note).toContain("9 esecuzioni saltate")
    expect(
      checkRoutine(book, routine, { context: nikcliFree, consent: routine.consent, busy: false }, at(18, 1)).kind,
    ).toBe("wait")
    // A daily routine closed over three days: one run, two missed.
    const daily = await made(nikcliFree, { id: "d", every: { kind: "daily", at: "07:30" }, createdAt: at(6) })
    expect(dueAt(daily, undefined, at(12, 0, 28))).toEqual({ due: true, missed: 2 })
  })

  test("a broken saved routine is dropped, never half-read", () => {
    const book = parseBook(
      JSON.stringify({
        routines: [
          { id: "ok", bot: "b", prompt: "p", every: { kind: "hours", hours: 2 }, consent: "c", createdAt: 1 },
          { id: "bad", bot: "b", prompt: "p", every: { kind: "hours", hours: 0 }, consent: "c", createdAt: 1 },
          { id: "time", bot: "b", prompt: "p", every: { kind: "daily", at: "25:00" }, consent: "c", createdAt: 1 },
        ],
      }),
    )
    expect(book.routines.map((routine) => routine.id)).toEqual(["ok"])
    expect(parseBook("{not json")).toEqual(EMPTY_BOOK)
  })
})

describe("B11: the scheduler", () => {
  function fakeTurn() {
    let finish: (result: TurnResult) => void = () => {}
    const turn: Turn = { result: new Promise<TurnResult>((resolve) => (finish = resolve)), stop: () => {} }
    return { turn, finish }
  }

  test("one run at a time, its cost written down, and a check that fails suspends", async () => {
    const a = await made(nikcliFree, { id: "a", bot: "A" })
    const b = await made(nikcliFree, { id: "b", bot: "B" })
    const store = memoryRoutineStore(addRoutine(addRoutine(EMPTY_BOOK, a), b))
    let clock = at(10)
    const started: string[] = []
    const turns = new Map<string, ReturnType<typeof fakeTurn>>()
    let refuse: string | undefined
    const scheduler = createRoutineScheduler({
      store,
      now: () => clock,
      botOf: async () => nikcliFree,
      prepare: async (routine) =>
        refuse === routine.id ? { ok: false, problem: "progetto non fidato" } : { ok: true, context: nikcliFree },
      start: (routine) => {
        started.push(routine.id)
        const fake = fakeTurn()
        turns.set(routine.id, fake)
        return fake.turn
      },
      running: () => false,
    })
    await scheduler.tick()
    await scheduler.tick()
    expect(started).toEqual(["a"])
    expect(scheduler.runningId()).toBe("a")
    turns.get("a")!.finish({ status: "done", text: "", tokens: 1, costUsd: 0, talk: emptyTalk() })
    await Promise.resolve()
    await Promise.resolve()
    expect(scheduler.runningId()).toBeUndefined()
    expect(store.get().logs["a"]?.note).toBe("Fatta.")
    refuse = "b"
    await scheduler.tick()
    expect(started).toEqual(["a"])
    expect(store.get().logs["b"]?.suspended).toBe("progetto non fidato")
    // A gone bot file suspends too.
    clock += 2 * HOUR
    const gone = createRoutineScheduler({
      store,
      now: () => clock,
      botOf: async () => undefined,
      prepare: async () => ({ ok: true, context: nikcliFree }),
      start: () => undefined,
      running: () => false,
    })
    await gone.tick()
    expect(store.get().logs["a"]?.suspended).toContain("file del bot")
  })

  test("the consent is asked again of the file prepare read, not the one botOf saw (review, BASSO 2)", async () => {
    const routine = await made(nikcliFree)
    const store = memoryRoutineStore(addRoutine(EMPTY_BOOK, routine))
    const started: string[] = []
    const scheduler = createRoutineScheduler({
      store,
      now: () => at(10),
      botOf: async () => nikcliFree,
      // Between the two reads the file was changed to a paid model.
      prepare: async () => ({ ok: true, context: nikcliPaid }),
      start: (routine) => {
        started.push(routine.id)
        return fakeTurn().turn
      },
      running: () => false,
    })
    await scheduler.tick()
    expect(started).toEqual([])
    expect(store.get().logs[routine.id]?.suspended).toContain("ridai il consenso")
  })
})
