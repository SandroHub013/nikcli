import { describe, expect, test } from "bun:test"
import type { AgentFile } from "./nikcli"
import { admit, fileFingerprint, memoryTrustStore, reachesShell } from "./trust"
import { t } from "../i18n"

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

  test("una domanda che non si apre è un no, con il motivo sullo schermo (B7)", async () => {
    // In ADE window.confirm è il comando confirm del plugin dialog, che la finestra non ha: rifiuta.
    const s = setup({ [projectBot.path]: "contenuto" })
    const deps = { ...s.deps, confirm: () => Promise.reject("dialog.confirm not allowed. Command not found") }
    const result = await admit(projectBot, deps)
    expect(result.ok).toBe(false)
    expect("problem" in result && result.problem).toContain("revisore")
    expect(s.store.get(projectBot.path)).toBeUndefined()
    // La domanda non resta «aperta»: il messaggio dopo chiede di nuovo.
    expect(await admit(projectBot, s.deps)).toEqual({ ok: false })
    expect(s.asked).toHaveLength(1)
  })

  test("un bot dell'utente (globale) non chiede niente", async () => {
    const s = setup({})
    expect(await admit(globalBot, s.deps)).toEqual({ ok: true })
    expect(s.asked).toHaveLength(0)
  })

  test("una domanda aperta non se ne apre una seconda per lo stesso bot (review B3, BASSO 1)", async () => {
    const s = setup({ [projectBot.path]: "contenuto" })
    let answer: (yes: boolean) => void = () => {}
    const deps = { ...s.deps, confirm: (question: string) => {
      s.asked.push(question)
      return new Promise<boolean>((resolve) => (answer = resolve))
    } }
    const first = admit(projectBot, deps)
    while (s.asked.length === 0) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(await admit(projectBot, deps)).toEqual({ ok: false })
    answer(true)
    expect(await first).toEqual({ ok: true })
    expect(s.asked).toHaveLength(1)
  })

  test("la domanda dice che cosa potrà fare, secondo il motore (review B3, BASSO 2)", async () => {
    const questions: Record<string, string> = {}
    for (const runner of ["claude", "codex", "nikcli"]) {
      const s = setup({ [projectBot.path]: "contenuto" }, [false])
      await admit({ ...projectBot, runner }, s.deps)
      questions[runner] = s.asked[0]!
    }
    expect(questions["codex"]).toContain("sola lettura")
    expect(questions["claude"]).toContain(".git")
    expect(questions["nikcli"]).toContain("configurazione di nikcli")
    expect(new Set(Object.values(questions)).size).toBe(3)
  })

  test("Codex in sola lettura esegue comandi, solo non scrive; Claude senza scrittura non promette modifiche (B3-bis)", async () => {
    const ask = async (bot: AgentFile) => {
      const s = setup({ [projectBot.path]: "contenuto" }, [false])
      await admit(bot, s.deps)
      return s.asked[0]!
    }
    const codex = await ask({ ...projectBot, runner: "codex" })
    expect(codex).toContain("sola lettura")
    expect(codex).toContain("comandi che non scrivono")
    const readOnly = await ask({ ...projectBot, runner: "claude", disabledTools: ["edit", "write"] })
    expect(readOnly).not.toContain("modificare gli altri file")
    expect(readOnly).toContain("solo leggere")
    expect(await ask({ ...projectBot, runner: "claude" })).toContain("modificare gli altri file")
  })

  test("l'impronta è quella del contenuto", async () => {
    expect(await fileFingerprint("a")).toBe(await fileFingerprint("a"))
    expect(await fileFingerprint("a")).not.toBe(await fileFingerprint("b"))
    expect(await fileFingerprint("a")).toMatch(/^[0-9a-f]{64}$/)
  })
})

/*
 * Review B3, A2: nikcli reads the bot's file itself, frontmatter included, so
 * a project's bot could pre-approve its own commands (`permission: bash:
 * allow`) and run them after the user was told it would ask first. Such a bot
 * does not start, and says why. Claude Code and Codex never read that key.
 */
describe("un bot di progetto per nikcli che si pre-approva", () => {
  const withFront = (front: string) => `---\ndescription: Revisore\n${front}\n---\nSei un revisore.`
  const refused = [
    "permission:\n  bash: allow",
    "permission: { bash: allow }",
    'permission: {"bash": "allow"}',
    "permission: allow",
    'permission:\n  bash:\n    "git *": allow',
    "permission:\n  edit: allow",
    "permission:\n  webfetch: allow",
    "permission:\n  external_directory: allow",
    "permission:\n  task: allow",
    'permission:\n  "*": allow',
    '"permission":\n  bash: allow',
    "tools:\n  bash: true",
    "tools: { write: true }",
  ]
  for (const front of refused) {
    test(`non parte: ${JSON.stringify(front)}`, async () => {
      const s = setup({ [projectBot.path]: withFront(front) }, [true])
      const result = await admit(projectBot, s.deps)
      expect(result.ok).toBe(false)
      expect("problem" in result && result.problem).toContain("revisore")
      expect(s.asked).toHaveLength(0)
      expect(s.store.get(projectBot.path)).toBeUndefined()
    })
  }

  test("non parte neanche con un BOM davanti o con le righe di Windows", async () => {
    const granting = withFront("permission:\n  bash: allow")
    for (const text of ["\uFEFF" + granting, granting.replace(/\n/g, "\r\n")]) {
      const s = setup({ [projectBot.path]: text }, [true])
      expect((await admit(projectBot, s.deps)).ok).toBe(false)
      expect(s.asked).toHaveLength(0)
    }
  })

  test("chiedere o negare va bene, e allora si chiede come sempre", async () => {
    const front = "permission:\n  bash: ask\n  edit: deny\ntools:\n  webfetch: false"
    const s = setup({ [projectBot.path]: withFront(front) }, [true])
    expect(await admit(projectBot, s.deps)).toEqual({ ok: true })
    expect(s.asked).toHaveLength(1)
  })

  test("un file già approvato che poi si pre-approva non parte più", async () => {
    const s = setup({ [projectBot.path]: withFront("mode: primary") }, [true])
    expect(await admit(projectBot, s.deps)).toEqual({ ok: true })
    s.files[projectBot.path] = withFront("permission:\n  bash: allow")
    expect((await admit(projectBot, s.deps)).ok).toBe(false)
  })

  test("su Claude Code o Codex la chiave non conta: nessuno dei due la legge", async () => {
    for (const runner of ["claude", "codex"]) {
      const s = setup({ [projectBot.path]: withFront("permission:\n  bash: allow") }, [true])
      expect(await admit({ ...projectBot, runner }, s.deps)).toEqual({ ok: true })
    }
  })

  test("un bot dell'utente non viene letto", async () => {
    const s = setup({})
    expect(await admit(globalBot, s.deps)).toEqual({ ok: true })
  })
})

/*
 * B8c: a grant of the shell or of a folder outside. Since B8d the panel's
 * session rules come after the bot's own (`serve-rules.test.ts`); what is left
 * here is how the gateway and a project's bot read the grant.
 */
describe("un bot che si concede la shell", () => {
  const withFront = (front: string) => `---\ndescription: Revisore\n${front}\n---\nSei un revisore.`
  test("reachesShell legge * e ? come nikcli", () => {
    expect(["bash", "*", "ba?h", "*_directory", "external_*"].map(reachesShell)).toEqual([true, true, true, true, true])
    expect(["read", "edit", "bash2", "webfetch"].map(reachesShell)).toEqual([false, false, false, false])
  })

  test("il bot di progetto che si pre-approva dice anche la riga", async () => {
    const s = setup({ [projectBot.path]: withFront('permission:\n  bash:\n    "git *": allow') }, [true])
    expect(await admit(projectBot, s.deps)).toEqual({
      ok: false,
      problem: t("bots.trust.selfApproves", "revisore", "git *", '"git *": allow'),
    })
  })
})
