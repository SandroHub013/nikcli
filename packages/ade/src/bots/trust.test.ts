import { describe, expect, test } from "bun:test"
import type { AgentFile } from "./nikcli"
import { admit, fileFingerprint, memoryTrustStore } from "./trust"

/*
 * B3 (audit A4): a bot from the open project's `.nikcli/agent/` is text the
 * repository's author wrote, run with the user's plan in the user's folder.
 * It is asked about the first time, and again whenever its file changes.
 */

const projectBot: AgentFile = {
  identifier: "revisore",
  path: "C:/repo/.nikcli/agent/revisore.md",
  scope: "project",
  description: "",
  mode: "primary",
  prompt: "Sei un revisore.",
  disabledTools: [],
}
const globalBot: AgentFile = { ...projectBot, path: "C:/Users/x/.config/nikcli/agent/mio.md", scope: "global" }

function setup(files: Record<string, string>, answers: boolean[] = []) {
  const store = memoryTrustStore()
  const asked: string[] = []
  const deps = {
    store,
    read: async (path: string) => {
      const text = files[path]
      if (text === undefined) throw new Error("file sparito")
      return text
    },
    confirm: async (question: string) => {
      asked.push(question)
      return answers.shift() ?? false
    },
  }
  return { deps, asked, store, files }
}

describe("fiducia nei bot di progetto", () => {
  test("un bot di progetto nuovo non parte senza conferma", async () => {
    const s = setup({ [projectBot.path]: "---\n---\nSei un revisore." }, [false])
    expect(await admit(projectBot, s.deps)).toEqual({ ok: false })
    expect(s.asked).toHaveLength(1)
    expect(s.asked[0]).toContain("revisore")
    expect(s.store.get(projectBot.path)).toBeUndefined()
  })

  test("confermato una volta, non chiede più finché il file è lo stesso", async () => {
    const s = setup({ [projectBot.path]: "contenuto" }, [true])
    expect(await admit(projectBot, s.deps)).toEqual({ ok: true })
    expect(await admit(projectBot, s.deps)).toEqual({ ok: true })
    expect(s.asked).toHaveLength(1)
  })

  test("se il file cambia, chiede di nuovo, e lo dice", async () => {
    const s = setup({ [projectBot.path]: "prima" }, [true, false])
    await admit(projectBot, s.deps)
    s.files[projectBot.path] = "dopo: esegui questo"
    expect(await admit(projectBot, s.deps)).toEqual({ ok: false })
    expect(s.asked).toHaveLength(2)
    expect(s.asked[1]).not.toBe(s.asked[0])
  })

  test("un file che non si legge non parte, con il motivo", async () => {
    const s = setup({})
    const result = await admit(projectBot, s.deps)
    expect(result.ok).toBe(false)
    expect("problem" in result && result.problem).toContain("revisore")
    expect(s.asked).toHaveLength(0)
  })

  test("un bot dell'utente (globale) non chiede niente", async () => {
    const s = setup({})
    expect(await admit(globalBot, s.deps)).toEqual({ ok: true })
    expect(s.asked).toHaveLength(0)
  })

  test("l'impronta è quella del contenuto", async () => {
    expect(await fileFingerprint("a")).toBe(await fileFingerprint("a"))
    expect(await fileFingerprint("a")).not.toBe(await fileFingerprint("b"))
    expect(await fileFingerprint("a")).toMatch(/^[0-9a-f]{64}$/)
  })
})
