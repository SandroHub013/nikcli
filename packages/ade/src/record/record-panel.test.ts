import { describe, expect, test } from "bun:test"
import { parseRequest, type PanelOutcome } from "../panels/protocol"
import { RECORD_VERBS, runRecordRequest, type RecordPanelDeps } from "./record-panel"
import type { RecordTarget } from "./recording"

function ask(line: string) {
  const request = parseRequest(line)
  if (!request) throw new Error(`non è una richiesta: ${line}`)
  return request
}

function deps(overrides: Partial<RecordPanelDeps> = {}) {
  const targets: RecordTarget[] = []
  const mics: boolean[] = []
  const asked: RecordTarget[] = []
  const languages: unknown[] = []
  const base: RecordPanelDeps = {
    confirm: async (target) => {
      asked.push(target)
      return { allowed: true, mic: false }
    },
    start: async (target, options) => {
      targets.push(target)
      mics.push(options.mic === true)
      languages.push(options.language)
      return undefined
    },
    stop: async (language) => {
      languages.push(language)
      return undefined
    },
    paneRect: (name) => (name === "3" ? { x: 100, y: 50, width: 800, height: 600 } : undefined),
    state: () => ({ recording: false }),
    ...overrides,
  }
  return { deps: base, targets, mics, asked, languages }
}

describe("record/record-panel", () => {
  /* Review of review-alti, 1.3: every take asks, and says who asks. */
  test("the question names the session that asks", async () => {
    const askers: (string | undefined)[] = []
    const { deps: d } = deps({
      confirm: async (_target, asker) => {
        askers.push(asker)
        return { allowed: false, mic: false }
      },
    })
    await runRecordRequest(ask("@ade record start"), d, "Sessione 2 — Claude Code")
    await runRecordRequest(ask("@ade record start"), d)
    expect(askers).toEqual(["Sessione 2 — Claude Code", undefined])
  })

  test("an agent records the window with one line", async () => {
    const { deps: d, targets } = deps()
    expect(await runRecordRequest(ask("@ade record start"), d)).toEqual({
      ok: true,
      detail: "registro la finestra, senza microfono",
    })
    expect(targets).toEqual([{ kind: "window" }])
  })

  test("nothing is recorded until the user says yes", async () => {
    const { deps: d, targets, asked } = deps({ confirm: async () => ({ allowed: false, mic: true }) })
    const outcome = await runRecordRequest(ask("@ade record start"), d)
    expect(outcome.ok).toBe(false)
    expect(outcome).toEqual({ ok: false, reason: "negato dall'utente" })
    expect(targets).toEqual([])
    expect(asked).toEqual([])
    const { deps: again, asked: askedAgain, targets: started } = deps()
    await runRecordRequest(ask("@ade record start"), again)
    await runRecordRequest(ask("@ade record start"), again)
    // Asked for each take: a yes is not kept for the next one.
    expect(askedAgain.length).toBe(2)
    expect(started.length).toBe(2)
  })

  test("the microphone follows the user's answer, not the agent's wish", async () => {
    const off = deps()
    await runRecordRequest(ask("@ade record start"), off.deps)
    expect(off.mics).toEqual([false])
    const on = deps({ confirm: async () => ({ allowed: true, mic: true }) })
    const outcome = await runRecordRequest(ask("@ade record start"), on.deps)
    expect(on.mics).toEqual([true])
    expect(outcome.ok && outcome.detail).toContain("con il microfono")
  })

  test("a take already running is not asked about again", async () => {
    const { deps: d, asked } = deps({ state: () => ({ recording: true }) })
    const outcome = await runRecordRequest(ask("@ade record start"), d)
    expect(outcome.ok).toBe(false)
    expect(asked).toEqual([])
  })

  test("a pane take carries the pane's rectangle, because only ADE knows it", async () => {
    const { deps: d, targets } = deps()
    expect(await runRecordRequest(ask("@ade record start 3"), d)).toEqual({
      ok: true,
      detail: "registro il pannello 3, senza microfono",
    })
    expect(targets).toEqual([{ kind: "pane", paneId: "3", x: 100, y: 50, width: 800, height: 600 }])
  })

  test("a pane that is not there is said so, not recorded as the window", async () => {
    const { deps: d, targets } = deps()
    const outcome = await runRecordRequest(ask("@ade record start 9"), d)
    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.reason).toContain("nessun pannello")
    expect(targets).toEqual([])
  })

  test("stop says where the take was saved, and refuses when nothing is running", async () => {
    const { deps: idle } = deps()
    const refused = await runRecordRequest(ask("@ade record stop"), idle)
    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.reason).toContain("non si sta registrando")

    const { deps: busy } = deps({ state: () => ({ recording: true, path: "C:/video/ADE.mp4" }) })
    expect(await runRecordRequest(ask("@ade record stop"), busy)).toEqual({
      ok: true,
      detail: "salvato in C:/video/ADE.mp4",
    })
  })

  test("a failure from the capture reaches the agent as the reason", async () => {
    const { deps: d } = deps({ start: async () => "Scegli prima la cartella dove salvare i video." })
    const outcome = await runRecordRequest(ask("@ade record start"), d)
    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.reason).toContain("cartella")
  })

  test("the reasons an agent gets back are asked for in Italian, whatever the interface language", async () => {
    const { deps: d, languages } = deps({ state: () => ({ recording: false, path: "C:/video/ADE.mp4" }) })
    await runRecordRequest(ask("@ade record start"), d)
    await runRecordRequest(ask("@ade record stop"), { ...d, state: () => ({ recording: true }) })
    expect(languages).toEqual(["it", "it"])
  })

  test("state answers whether a take is running", async () => {
    const { deps: d } = deps({ state: () => ({ recording: true, path: "C:/video/ADE.mp4" }) })
    expect(await runRecordRequest(ask("@ade record state"), d)).toEqual({
      ok: true,
      detail: "registro in C:/video/ADE.mp4",
    })
    const { deps: idle } = deps()
    expect(await runRecordRequest(ask("@ade record state"), idle)).toEqual({
      ok: true,
      detail: "nessuna registrazione",
    })
  })

  test("an unknown verb is refused, and every verb offered answers for itself", async () => {
    const refused = await runRecordRequest(ask("@ade record zoom"), deps().deps)
    expect(refused).toEqual({ ok: false, reason: "comando sconosciuto: zoom" })

    /*
     * What each offered verb answers while a take is already running, with no
     * path on the state. Every verb gets its own exact answer. The
     * `toBeDefined` that stood here proved nothing: `PanelOutcome` is a union of
     * two non-nullable objects, so the assertion held for any behaviour at all,
     * including one that refused every verb as unknown and left nothing able to
     * record.
     */
    const WHILE_RUNNING: Record<string, PanelOutcome> = {
      start: { ok: false, reason: "una registrazione è già in corso" },
      stop: { ok: true, detail: "registrazione chiusa" },
      state: { ok: true, detail: "registro in corso" },
    }
    // A verb added to RECORD_VERBS has to bring its own expected answer with it,
    // or this test quietly stops covering the list it walks.
    expect(Object.keys(WHILE_RUNNING).sort()).toEqual(RECORD_VERBS.map((verb) => verb.name).sort())

    const answers: Record<string, PanelOutcome> = {}
    for (const verb of RECORD_VERBS) {
      answers[verb.name] = await runRecordRequest(
        ask(`@ade record ${verb.name}`),
        deps({ state: () => ({ recording: true }) }).deps,
      )
    }
    expect(answers).toEqual(WHILE_RUNNING)
  })
})
