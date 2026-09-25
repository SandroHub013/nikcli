import { describe, expect, test } from "bun:test"
import type { AgentFile } from "./nikcli"
import { runRoutine } from "./routine"
import { routineConsentHash, routineConsentHolds, routineModeOf, routinePolicy, ROUTINE_POLICY } from "./terms"
import type { TurnDeps } from "./turn"

const bot = (runner: string): AgentFile => ({
  identifier: runner,
  path: `C:/p/.nikcli/agent/${runner}.md`,
  scope: "global",
  description: "",
  mode: "primary",
  prompt: "fai il punto",
  disabledTools: [],
  runner,
})

describe("quali routine sono consentite", () => {
  test("il modo di nikcli viene dal modello del catalogo, non dal nome", () => {
    expect(routineModeOf("nikcli", undefined, "openrouter/free-looking")).toBe("paid")
    expect(routineModeOf("nikcli", "key", "google/gemini-2.0-flash:free")).toBe("free")
    expect(routineModeOf("claude", "key", "opus")).toBe("key")
    expect(routineModeOf("codex", undefined, "gpt-5.5")).toBe("plan")
  })

  test("Codex con chiave è escluso, e un modo sconosciuto pure", () => {
    const codex = routinePolicy("codex", "key", "gpt-5.5")
    expect(codex.allowed).toBe(false)
    if (!codex.allowed) expect(codex.reason).toContain("non riporta un costo")
    expect(routinePolicy("grok", "plan").allowed).toBe(false)
    expect(routinePolicy("grok", "key").allowed).toBe(false)
    expect(routinePolicy("claude", "free").allowed).toBe(false)
    const paidNamedFree = routinePolicy("nikcli", "free", "openai/gpt-4o")
    expect(paidNamedFree.allowed).toBe(true)
    if (paidNamedFree.allowed) expect(paidNamedFree.cap.spendCapRequired).toBe(true)
  })

  test("ogni riga consentita ha fonte e data, e la chiave ha il tetto", () => {
    for (const row of ROUTINE_POLICY) {
      if (!row.allowed) continue
      expect(row.source).toBeTruthy()
      expect(row.checked).toBeTruthy()
      expect(row.cap).toBeTruthy()
    }
    const claude = routinePolicy("claude", "key")
    expect(claude.allowed).toBe(true)
    if (claude.allowed) expect(claude.cap.spendCapRequired).toBe(true)
  })

  test("cambiare modo o nome della chiave toglie il consenso", async () => {
    const base = { prompt: "fai il punto", runner: "claude", mode: "plan", model: "opus", cap: "8" }
    const saved = await routineConsentHash(base)
    expect(routineConsentHolds(saved, saved)).toBe(true)
    expect(routineConsentHolds(saved, await routineConsentHash({ ...base, mode: "key", key: "lavoro" }))).toBe(false)
    expect(routineConsentHolds(saved, await routineConsentHash({ ...base, mode: "key", key: "altra" }))).toBe(false)
    const keyed = await routineConsentHash({ ...base, mode: "key", key: "lavoro" })
    expect(routineConsentHolds(keyed, await routineConsentHash({ ...base, mode: "key", key: "altra" }))).toBe(false)
  })

  test("routineConsentHash con SHA-256 (crypto.subtle): stesso input stesso hash, ogni campo cambiato cambia l'hash, vecchio hash non accettato", async () => {
    const base = {
      prompt: "fai il punto",
      runner: "claude",
      mode: "plan",
      model: "opus",
      cap: "8",
      key: "lavoro",
    }
    const hash1 = await routineConsentHash(base)
    const hash2 = await routineConsentHash(base)

    // Stesso input: produce lo stesso hash SHA-256 in esadecimale (64 caratteri)
    expect(hash1).toBe(hash2)
    expect(hash1).toMatch(/^[0-9a-f]{64}$/)
    expect(routineConsentHolds(hash1, hash2)).toBe(true)

    // Ogni campo cambiato cambia l'hash:
    // 1. prompt
    expect(await routineConsentHash({ ...base, prompt: "altro prompt" })).not.toBe(hash1)
    // 2. runner
    expect(await routineConsentHash({ ...base, runner: "codex" })).not.toBe(hash1)
    // 3. modo
    expect(await routineConsentHash({ ...base, mode: "key" })).not.toBe(hash1)
    // 4. nome della chiave
    expect(await routineConsentHash({ ...base, key: "altra_chiave" })).not.toBe(hash1)
    expect(await routineConsentHash({ ...base, key: undefined })).not.toBe(hash1)
    // 5. modello
    expect(await routineConsentHash({ ...base, model: "sonnet" })).not.toBe(hash1)
    // 6. tetto
    expect(await routineConsentHash({ ...base, cap: "10" })).not.toBe(hash1)

    // Un consenso salvato con l'hash vecchio va ridato, non accettato
    const oldLegacyHash = [base.prompt, base.runner, base.mode, base.model, base.cap, base.key ?? ""].join("\u001f")
    expect(routineConsentHolds(oldLegacyHash, hash1)).toBe(false)
    expect(routineConsentHolds(oldLegacyHash, oldLegacyHash)).toBe(false)
  })
})

describe("una routine parte come gli altri spawn", () => {
  test("porta il flag dell'account, e Codex con chiave non parte", async () => {
    const seen: { flags?: readonly string[]; secrets?: readonly string[] }[] = []
    let exit: (code: number | null) => void = () => {}
    const deps: TurnDeps = {
      host: async () =>
        ({
          spawn: async (options: { flags?: readonly string[]; secrets?: readonly string[]; onExit: (code: number | null) => void }) => {
            seen.push({
              ...(options.flags ? { flags: options.flags } : {}),
              ...(options.secrets ? { secrets: options.secrets } : {}),
            })
            exit = options.onExit
            return { kill: () => {}, write: () => {}, resize: () => {} }
          },
        }) as unknown as Awaited<ReturnType<NonNullable<TurnDeps["host"]>>>,
    }
    const turn = runRoutine({ runner: "claude", message: "ciao", bot: bot("claude"), account: { mode: "key", key: "lavoro" } }, deps)
    while (seen.length === 0) await new Promise((resolve) => setTimeout(resolve, 1))
    exit(0)
    await turn.result
    expect(seen[0]!.flags).toEqual(["account-key"])
    expect(seen[0]!.secrets).toEqual(["lavoro"])

    const refused = await runRoutine(
      { runner: "codex", message: "ciao", bot: bot("codex"), account: { mode: "key", key: "lavoro" } },
      deps,
    ).result
    expect(seen).toHaveLength(1)
    expect(refused.status).toBe("error")
    expect(refused.problem).toContain("non riporta un costo")
  })
})
