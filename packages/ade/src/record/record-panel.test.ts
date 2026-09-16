import { describe, expect, test } from "bun:test"
import { parseRequest } from "../panels/protocol"
import { RECORD_VERBS, runRecordRequest, type RecordPanelDeps } from "./record-panel"
import type { RecordTarget } from "./recording"

function ask(line: string) {
  const request = parseRequest(line)
  if (!request) throw new Error(`non è una richiesta: ${line}`)
  return request
}

function deps(overrides: Partial<RecordPanelDeps> = {}) {
  const targets: RecordTarget[] = []
  const base: RecordPanelDeps = {
    start: async (target) => {
      targets.push(target)
      return undefined
    },
    stop: async () => undefined,
    paneRect: (name) => (name === "3" ? { x: 100, y: 50, width: 800, height: 600 } : undefined),
    state: () => ({ recording: false }),
    ...overrides,
  }
  return { deps: base, targets }
}

describe("record/record-panel", () => {
  test("an agent records the window with one line", async () => {
    const { deps: d, targets } = deps()
    expect(await runRecordRequest(ask("@ade record start"), d)).toEqual({ ok: true, detail: "registro la finestra" })
    expect(targets).toEqual([{ kind: "window" }])
  })

  test("a pane take carries the pane's rectangle, because only ADE knows it", async () => {
    const { deps: d, targets } = deps()
    expect(await runRecordRequest(ask("@ade record start 3"), d)).toEqual({ ok: true, detail: "registro il pannello 3" })
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

  test("state answers whether a take is running", async () => {
    const { deps: d } = deps({ state: () => ({ recording: true, path: "C:/video/ADE.mp4" }) })
    expect(await runRecordRequest(ask("@ade record state"), d)).toEqual({ ok: true, detail: "registro in C:/video/ADE.mp4" })
    const { deps: idle } = deps()
    expect(await runRecordRequest(ask("@ade record state"), idle)).toEqual({ ok: true, detail: "nessuna registrazione" })
  })

  test("an unknown verb is refused, and every verb offered has an answer", async () => {
    const { deps: d } = deps()
    const outcome = await runRecordRequest(ask("@ade record zoom"), d)
    expect(outcome.ok).toBe(false)
    for (const verb of RECORD_VERBS) {
      const answered = await runRecordRequest(ask(`@ade record ${verb.name}`), deps({ state: () => ({ recording: true }) }).deps)
      expect(answered).toBeDefined()
    }
  })
})
