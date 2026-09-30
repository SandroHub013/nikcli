import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createCloser } from "./closer"

/*
 * F-confirm-bis. The unsaved-file question is answered later, so a close
 * says whether it happened, and several closes ask one file at a time.
 */

function setup(unsaved: Record<string, string>) {
  const panes = new Set(["a", "b", "c", ...Object.keys(unsaved)])
  const closed: string[] = []
  const questions: { path: string; answer: (yes: boolean) => void }[] = []
  const closer = createCloser({
    unsaved: (id) => unsaved[id],
    ask: (path) => new Promise<boolean>((resolve) => questions.push({ path, answer: resolve })),
    closeNow: (id) => {
      closed.push(id)
      panes.delete(id)
    },
    exists: (id) => panes.has(id),
  })
  return { closer, closed, questions, panes }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("chiudere un pannello con un file non salvato", () => {
  test("un pannello senza modifiche si chiude subito, e close lo dice", () => {
    const s = setup({})
    expect(s.closer.close("a")).toBe(true)
    expect(s.closed).toEqual(["a"])
  })

  test("con un file non salvato close dice che non ha chiuso, e al no resta aperto (BASSO 1)", async () => {
    const s = setup({ f: "C:/p/a.ts" })
    expect(s.closer.close("f")).toBe(false)
    expect(s.closed).toEqual([])
    expect(s.questions.map((q) => q.path)).toEqual(["C:/p/a.ts"])
    s.questions[0]!.answer(false)
    await tick()
    expect(s.closed).toEqual([])
    // Asked again after the no: the question is not stuck open.
    expect(s.closer.close("f")).toBe(false)
    expect(s.questions).toHaveLength(2)
    s.questions[1]!.answer(true)
    await tick()
    expect(s.closed).toEqual(["f"])
  })

  test("un secondo close con la domanda aperta non ne apre un'altra", async () => {
    const s = setup({ f: "C:/p/a.ts" })
    const first = s.closer.closeAsking("f")
    expect(s.closer.close("f")).toBe(false)
    expect(s.questions).toHaveLength(1)
    s.questions[0]!.answer(true)
    expect(await first).toBe(true)
  })

  test("un pannello sparito prima del sì non si chiude due volte", async () => {
    const s = setup({ f: "C:/p/a.ts" })
    const done = s.closer.closeAsking("f")
    s.panes.delete("f")
    s.questions[0]!.answer(true)
    expect(await done).toBe(false)
    expect(s.closed).toEqual([])
  })

  test("una domanda che non si apre tiene il file aperto", async () => {
    const closed: string[] = []
    const closer = createCloser({
      unsaved: () => "C:/p/a.ts",
      ask: () => Promise.reject(new Error("dialog")),
      closeNow: (id) => void closed.push(id),
      exists: () => true,
    })
    expect(await closer.closeAsking("f")).toBe(false)
    expect(closed).toEqual([])
  })

  test("lint: the workbench goes through closeAll, asks before it closes, and never closes a vanished pane directly for an ade-msg", () => {
    const source = readFileSync(join(import.meta.dir, "../surface/workbench.tsx"), "utf8")
    expect(source).toContain("await closer.closeAll(")
    expect(source).not.toMatch(/pane\.gone && !running\.has\(pane\.id\)\) close\(pane\.id\)/)
    const tree = source.slice(source.indexOf("const closeTree = async"), source.indexOf("const excludeAdeResults"))
    expect(tree).toContain("asking.push(pane.title)")
    expect(tree.indexOf("asking.push(pane.title)")).toBeLessThan(tree.indexOf("closed.push(pane.title)"))
  })

  /*
   * Chiudere tutte le sessioni di un progetto, e la ✕ della riga della
   * sidebar, passavano gli id senza dire come: un agente al lavoro veniva
   * chiuso senza parola, mentre la stessa chiusura dal pulsante del pannello
   * chiede prima (review sidebar-clic, ALTO 1 e MEDIO 2).
   */
  test("chiudere le sessioni di un progetto e la ✕ della riga chiedono prima di fermare un agente in esecuzione", () => {
    const source = readFileSync(join(import.meta.dir, "../surface/workbench.tsx"), "utf8")

    const closeAll = source.slice(source.indexOf("const closeProjectSessions"), source.indexOf("const projectOfPane"))
    expect(closeAll).toContain("confirmRunning: true")

    const fromSidebar = source.slice(source.indexOf("onCloseSession="), source.indexOf("onRestartSession="))
    expect(fromSidebar).toContain("confirmRunning: true")
  })

  test("closeAll con confirmRunning chiede prima, e al no l'agente resta al lavoro (ALTO 1)", async () => {
    const panes = new Set(["a", "b"])
    const closed: string[] = []
    const asks: { agent: string; answer: (yes: boolean) => void }[] = []
    const closer = createCloser({
      unsaved: () => undefined,
      ask: () => Promise.resolve(true),
      closeNow: (id) => {
        closed.push(id)
        panes.delete(id)
      },
      exists: (id) => panes.has(id),
      running: (id) => (id === "b" ? "Claude Code" : undefined),
      askRunning: (agent) => new Promise<boolean>((resolve) => asks.push({ agent, answer: resolve })),
    })

    const all = closer.closeAll(["a", "b"], { confirmRunning: true })
    await tick()
    // A pane with no agent still goes at once: the question is only for the one at work.
    expect(closed).toEqual(["a"])
    expect(asks.map((q) => q.agent)).toEqual(["Claude Code"])

    asks[0]!.answer(false)
    await all
    expect(closed).toEqual(["a"])
  })

  test("closeAll chiede un file alla volta (BASSO 2)", async () => {
    const s = setup({ f: "C:/p/f.ts", g: "C:/p/g.ts" })
    const all = s.closer.closeAll(["a", "f", "g", "b"])
    await tick()
    expect(s.closed).toEqual(["a"])
    expect(s.questions.map((q) => q.path)).toEqual(["C:/p/f.ts"])
    s.questions[0]!.answer(false)
    await tick()
    expect(s.questions.map((q) => q.path)).toEqual(["C:/p/f.ts", "C:/p/g.ts"])
    s.questions[1]!.answer(true)
    await all
    expect(s.closed).toEqual(["a", "g", "b"])
  })
})
