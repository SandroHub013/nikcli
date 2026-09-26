import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import type { AgentFile } from "./nikcli"
import { admitProject, configGrant, projectSurface, type ProjectFs } from "./project-trust"
import { t } from "../i18n"
import { memoryTrustStore } from "./trust"

/*
 * B3b (review B3, M2): every nikcli turn runs in the project, and nikcli loads
 * the project's configuration: `nikcli.json`, and `.nikcli/` with its plugins
 * and tools — code, run at start — and a `package.json` whose scripts
 * `bun install` runs. That is trust in the project, not in a bot: asked once
 * per project, and again when any of it changes.
 */

const ROOT = "C:/progetto"

function fakeFs(files: Record<string, string>): ProjectFs & { files: Record<string, string> } {
  const all = files
  return {
    files: all,
    async readDir(path) {
      const prefix = `${path}/`
      const names = new Map<string, boolean>()
      for (const file of Object.keys(all)) {
        if (!file.startsWith(prefix)) continue
        const rest = file.slice(prefix.length)
        const [first, ...deeper] = rest.split("/")
        names.set(first!, deeper.length > 0 || names.get(first!) === true)
      }
      if (names.size === 0) throw new Error("ENOENT")
      return [...names].map(([name, is_dir]) => ({ name, is_dir }))
    },
    async readText(path) {
      const text = all[path]
      if (text === undefined) throw new Error("ENOENT")
      return { text, truncated: false }
    },
  }
}

function setup(files: Record<string, string>, answers: boolean[] = []) {
  const fs = fakeFs(files)
  const store = memoryTrustStore()
  const asked: string[] = []
  const deps = {
    store,
    surface: () => projectSurface(ROOT, fs),
    confirm: async (question: string) => {
      asked.push(question)
      return answers.shift() ?? false
    },
  }
  return { fs, store, asked, deps }
}

const generated = {
  [`${ROOT}/.nikcli/package.json`]: '{"dependencies":{"@nikcli-ai/plugin":"1.384.0"}}',
  [`${ROOT}/.nikcli/.gitignore`]: "node_modules\npackage.json\nbun.lock\n.gitignore",
  [`${ROOT}/.nikcli/bun.lock`]: "{}",
  [`${ROOT}/.nikcli/node_modules/@nikcli-ai/plugin/index.js`]: "export {}",
}

describe("la fiducia nel progetto, per i turni nikcli", () => {
  test("un progetto senza configurazione di nikcli non chiede niente", async () => {
    const s = setup({ [`${ROOT}/src/a.ts`]: "x" })
    expect(await admitProject(ROOT, s.deps)).toEqual({ ok: true })
    expect(s.asked).toHaveLength(0)
  })

  test("quello che nikcli scrive da sé in .nikcli non conta", async () => {
    const s = setup(generated)
    expect(await projectSurface(ROOT, s.fs)).toEqual([])
    expect(await admitProject(ROOT, s.deps)).toEqual({ ok: true })
    expect(s.asked).toHaveLength(0)
  })

  test("un plugin del progetto chiede una volta, e poi non più finché non cambia", async () => {
    const s = setup({ ...generated, [`${ROOT}/.nikcli/plugin/spia.ts`]: "export default () => {}" }, [true])
    expect(await admitProject(ROOT, s.deps)).toEqual({ ok: true })
    expect(await admitProject(ROOT, s.deps)).toEqual({ ok: true })
    expect(s.asked).toHaveLength(1)
    expect(s.asked[0]).toContain("plugin/spia.ts")
    expect(s.asked[0]).toContain(ROOT)
  })

  test("un plugin cambiato chiede di nuovo, e un no ferma il turno con il motivo", async () => {
    const s = setup({ [`${ROOT}/.nikcli/plugin/spia.ts`]: "prima" }, [true, false])
    await admitProject(ROOT, s.deps)
    s.fs.files[`${ROOT}/.nikcli/plugin/spia.ts`] = "dopo"
    const result = await admitProject(ROOT, s.deps)
    expect(result.ok).toBe(false)
    expect("problem" in result && result.problem).toContain(ROOT)
    expect(s.asked).toHaveLength(2)
    expect(s.asked[1]).not.toBe(s.asked[0])
  })

  test("un no non si ricorda come sì", async () => {
    const s = setup({ [`${ROOT}/.nikcli/plugin/spia.ts`]: "x" }, [false, true])
    expect((await admitProject(ROOT, s.deps)).ok).toBe(false)
    expect(await admitProject(ROOT, s.deps)).toEqual({ ok: true })
    expect(s.asked).toHaveLength(2)
  })

  test("contano config, strumenti, file importati e gli script del package.json", async () => {
    const s = setup({
      ...generated,
      [`${ROOT}/nikcli.json`]: '{"permission":{"bash":"allow"}}',
      [`${ROOT}/.nikcli/nikcli.jsonc`]: "{}",
      [`${ROOT}/.nikcli/tools/esegui.ts`]: "x",
      [`${ROOT}/.nikcli/lib/aiuto.ts`]: "x",
      [`${ROOT}/.nikcli/package.json`]: '{"scripts":{"postinstall":"calc"},"dependencies":{"@nikcli-ai/plugin":"1"}}',
    })
    const paths = (await projectSurface(ROOT, s.fs)).map((file) => file.path)
    expect(paths).toEqual(
      expect.arrayContaining([
        "nikcli.json",
        ".nikcli/nikcli.jsonc",
        ".nikcli/tools/esegui.ts",
        ".nikcli/lib/aiuto.ts",
        ".nikcli/package.json",
      ]),
    )
    expect(paths).not.toContain(".nikcli/bun.lock")
    expect(paths.some((path) => path.includes("node_modules"))).toBe(false)
  })

  test("il plugin che nikcli aggiunge al package.json non fa richiedere", async () => {
    const s = setup({ [`${ROOT}/.nikcli/plugin/a.ts`]: "x", [`${ROOT}/.nikcli/package.json`]: "{}" }, [true])
    await admitProject(ROOT, s.deps)
    s.fs.files[`${ROOT}/.nikcli/package.json`] = '{"dependencies":{"@nikcli-ai/plugin":"1.384.0"}}'
    expect(await admitProject(ROOT, s.deps)).toEqual({ ok: true })
    expect(s.asked).toHaveLength(1)
  })

  test("i bot del progetto contano solo se si concedono permessi (gli altri li copre B3)", async () => {
    const s = setup({
      [`${ROOT}/.nikcli/agent/buono.md`]: "---\ndescription: B\n---\nCiao",
      [`${ROOT}/.nikcli/agents/sub/furbo.md`]: "---\ndescription: F\npermission:\n  bash: allow\n---\nCiao",
    })
    const paths = (await projectSurface(ROOT, s.fs)).map((file) => file.path)
    expect(paths).toEqual([".nikcli/agents/sub/furbo.md"])
  })

  test("una domanda che non si apre è un no, con il motivo sullo schermo (B7)", async () => {
    const s = setup({ [`${ROOT}/.nikcli/plugin/a.ts`]: "x" })
    const deps = { ...s.deps, confirm: () => Promise.reject(new Error("dialog.confirm not allowed")) }
    const result = await admitProject(ROOT, deps)
    expect(result.ok).toBe(false)
    expect("problem" in result && result.problem).toContain(ROOT)
    expect(s.store.get(ROOT)).toBeUndefined()
  })

  /* C2 review, M2: who asks meanwhile gets the same answer, not a bare no. */
  test("una domanda aperta non se ne apre una seconda: chi arriva intanto riceve la stessa risposta", async () => {
    const s = setup({ [`${ROOT}/.nikcli/plugin/a.ts`]: "x" })
    let answer: (yes: boolean) => void = () => {}
    const deps = {
      ...s.deps,
      confirm: (question: string) => {
        s.asked.push(question)
        return new Promise<boolean>((resolve) => (answer = resolve))
      },
    }
    const first = admitProject(ROOT, deps)
    while (s.asked.length === 0) await new Promise((resolve) => setTimeout(resolve, 1))
    const second = admitProject(ROOT, deps)
    answer(true)
    expect(await first).toEqual({ ok: true })
    expect(await second).toEqual({ ok: true })
    expect(s.asked).toHaveLength(1)
  })
})

/*
 * B8c: a project's `nikcli.json` can grant a bot what its file does not:
 * `agent.<name>` is merged with the bot's file. The gateway does not start a
 * nikcli bot with such a grant (`gateway/policy.ts`); in the panel its
 * session's rules on ADE's server come after it (B8d).
 */
describe("i permessi concessi dal nikcli.json del progetto", () => {
  const granting: [string, string][] = [
    ['{"agent":{"mio":{"permission":{"bash":"allow"}}}}', 'agent."mio".permission."bash"'],
    ['{"agent":{"mio":{"permission":{"bash":{"*":"ask","git push *":"allow"}}}}}', 'agent."mio".permission."bash"."git push *"'],
    ['{"agent":{"mio":{"permission":{"*":"allow"}}}}', 'agent."mio".permission."*"'],
    ['{"agent":{"mio":{"permission":"allow"}}}', 'agent."mio".permission'],
    ['{"agent":{"mio":{"tools":{"bash":true}}}}', 'agent."mio".tools."bash"'],
    ['{"mode":{"mio":{"permission":{"external_directory":"allow"}}}}', 'mode."mio".permission."external_directory"'],
    ['{"permission":{"bash":"ask","*":"allow"}}', 'permission."*"'],
    ['{"permission":{"bash":{"rm *":"allow"}}}', 'permission."bash"."rm *"'],
    ['{\n  // commento\n  "agent": { "mio": { "permission": { "bash": "allow", }, }, },\n}', 'agent."mio".permission."bash"'],
  ]
  for (const [config, key] of granting) {
    test(`configGrant: ${config.replace(/\s+/g, " ")}`, () => {
      expect(configGrant(config, "mio")).toBe(key)
    })
  }

  test("configGrant: ask, deny, altri strumenti e altri bot non contano", () => {
    for (const config of [
      '{"agent":{"mio":{"permission":{"bash":"ask","edit":"allow"}}}}',
      '{"agent":{"altro":{"permission":{"bash":"allow"}}}}',
      '{"permission":{"bash":{"*":"ask","git status":"deny"},"read":{"*":"allow"}}}',
      '{"model":"openrouter/x:free","url":"http://a/*/b"}',
    ]) {
      expect([config, configGrant(config, "mio")]).toEqual([config, undefined])
    }
  })

  test("configGrant: un file che non si legge è un rifiuto (null)", () => {
    expect(configGrant('{"agent": {"mio": ', "mio")).toBeNull()
    expect(configGrant("[1, 2]", "mio")).toBeNull()
  })

  /* B8d: the session's rules on ADE's server come after any grant, so the panel admits the project and nothing else. */
  test("il pannello non ferma più un bot nikcli per un permesso concesso: ammette il progetto", () => {
    const view = readFileSync(new URL("./bots.tsx", import.meta.url), "utf8")
    const checks = view.slice(view.indexOf("async function admitTurn"), view.indexOf("return { ok: true, bot: trusted }"))
    expect(checks).not.toContain("grantProblem")
    expect(checks).toMatch(/const nikcli = runnerById\(trusted\.runner\)\.id === "nikcli"[\s\S]*if \(root && nikcli\) \{\s*const project = await admitProject\(/)
    // The panel's turn and a routine's run (B11) both pass there before they start.
    const start = view.slice(view.indexOf("const start = async"), view.indexOf("return turns.send(verdict.bot"))
    expect(start).toContain("await admitTurn(bot, props.projectRoot, askTrust)")
    const prepare = view.slice(view.indexOf("prepare: async (routine)"), view.indexOf("clearedBots.set(routine.id"))
    expect(prepare).toContain("await admitTurn(bot, routine.cwd, () => false)")
  })
})
