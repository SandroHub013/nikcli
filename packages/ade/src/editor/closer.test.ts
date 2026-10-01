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

/*
 * C1 (ADE e i file sul computer dell'utente). Una sessione con la sua worktree: chiuderla dalla ✕ non butta il lavoro che non è stato
 * integrato. La cartella resta comunque su disco (`session/worktree-close.ts`), ma l'utente lo sa prima.
 */
describe("chiudere una sessione con una worktree", () => {
  function tree(work: Record<string, string | undefined>, options: { unsaved?: Record<string, string>; workFails?: boolean } = {}) {
    const panes = new Set(["a", ...Object.keys(work)])
    const closed: string[] = []
    const checked: string[] = []
    const asks: { reason: string; answer: (yes: boolean) => void }[] = []
    const closer = createCloser({
      unsaved: (id) => options.unsaved?.[id],
      ask: () => Promise.resolve(true),
      closeNow: (id) => {
        closed.push(id)
        panes.delete(id)
      },
      exists: (id) => panes.has(id),
      hasWorktree: (id) => id in work,
      worktreeWork: async (id) => {
        checked.push(id)
        if (options.workFails) throw new Error("git")
        return work[id]
      },
      askWorktree: (reason) => new Promise<boolean>((resolve) => asks.push({ reason, answer: resolve })),
    })
    return { closer, closed, checked, asks }
  }

  test("integrata e pulita: si chiude senza domande (dopo il controllo di git, quindi non nello stesso istante)", async () => {
    const s = tree({ w: undefined })
    expect(s.closer.close("w")).toBe(false)
    await tick()
    expect(s.checked).toEqual(["w"])
    expect(s.asks).toEqual([])
    expect(s.closed).toEqual(["w"])
  })

  test("con lavoro non integrato chiede, dicendo cosa c'è, e al no la sessione resta aperta", async () => {
    const s = tree({ w: "ha modifiche non committate in C:/work/app-worktrees/w" })
    s.closer.close("w")
    await tick()
    expect(s.asks.map((q) => q.reason)).toEqual(["ha modifiche non committate in C:/work/app-worktrees/w"])
    s.asks[0]!.answer(false)
    await tick()
    expect(s.closed).toEqual([])
  })

  test("al sì si chiude (la cartella e il suo branch restano, lo decide la bonifica, non la domanda)", async () => {
    const s = tree({ w: "ha commit non integrati" })
    s.closer.close("w")
    await tick()
    s.asks[0]!.answer(true)
    await tick()
    expect(s.closed).toEqual(["w"])
  })

  test("una chiusura già decisa (ade-msg close, che rifiuta da sé il lavoro non integrato) non chiede una seconda volta", () => {
    const s = tree({ w: "ha commit non integrati" })
    expect(s.closer.close("w", { decided: true })).toBe(true)
    expect(s.closed).toEqual(["w"])
    expect(s.checked).toEqual([])
  })

  test("un pannello senza worktree si chiude subito, come prima", () => {
    const s = tree({})
    expect(s.closer.close("a")).toBe(true)
    expect(s.checked).toEqual([])
  })

  test("un controllo di git che fallisce non tiene la sessione aperta: la bonifica poi non toglie nulla che non sia pulito", async () => {
    const s = tree({ w: "ha commit non integrati" }, { workFails: true })
    s.closer.close("w")
    await tick()
    expect(s.asks).toEqual([])
    expect(s.closed).toEqual(["w"])
  })

  test("con un file non salvato la domanda è una sola, e è quella del file", async () => {
    const s = tree({ w: "ha commit non integrati" }, { unsaved: { w: "C:/p/a.ts" } })
    s.closer.close("w")
    await tick()
    expect(s.checked).toEqual([])
    expect(s.asks).toEqual([])
  })

  test("senza le funzioni della worktree il closer si comporta come prima", () => {
    const closed: string[] = []
    const closer = createCloser({ unsaved: () => undefined, ask: () => Promise.resolve(true), closeNow: (id) => void closed.push(id), exists: () => true })
    expect(closer.close("w")).toBe(true)
    expect(closed).toEqual(["w"])
  })
})

describe("la worktree torna indietro da qualunque strada si chiuda la sessione (lint sul workbench)", () => {
  const source = readFileSync(join(import.meta.dir, "../surface/workbench.tsx"), "utf8")

  test("closeNow, dove passano ✕, scorciatoia, progetto e ade-msg close, restituisce la worktree", () => {
    const closeNow = source.slice(source.indexOf("const closeNow = (id: string)"), source.indexOf("const finish = "))
    expect(closeNow).toContain("giveBackWorktree(closing, closing.worktree)")
    // Before the pane is removed: the pane is what says where the worktree and the project are.
    expect(closeNow.indexOf("giveBackWorktree(")).toBeLessThan(closeNow.indexOf("setWb((w) => closePane(w, id))"))
  })

  test("ade-msg close non decide da sé: non ripete la domanda e non toglie la worktree a mano", () => {
    const tree = source.slice(source.indexOf("const closeTree = async"), source.indexOf("const excludeAdeResults"))
    expect(tree).toContain("closer.close(id, { decided: true })")
    expect(tree).not.toContain('"worktree", "remove"')
  })

  test("l'unico git worktree remove del workbench è quello di session/worktree-close.ts", () => {
    expect(source.includes('"worktree", "remove"')).toBe(false)
    const module = readFileSync(join(import.meta.dir, "../session/worktree-close.ts"), "utf8")
    expect(module).toContain('["worktree", "remove", facts.worktree]')
    expect(module).toContain('["branch", "-d", facts.branch]')
    expect(module.includes('"-D"')).toBe(false)
  })
})
