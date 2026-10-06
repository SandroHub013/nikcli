import { describe, expect, test } from "bun:test"
import {
  addedLabel,
  billingWarning,
  envProblem,
  keyError,
  keysForAgent,
  nameProblem,
  runKeysCommand,
  suggestEnv,
  valueProblem,
  type KeyInfo,
} from "./keys"

const key = (name: string, env: string, agents: string[], masked: string | null = "••••••••abcd"): KeyInfo => ({
  name,
  env,
  agents,
  createdMs: 0,
  ...(masked ? { masked } : {}),
})

describe("the form's checks match the host's", () => {
  test("names", () => {
    expect(nameProblem("GitHub token")).toBeUndefined()
    expect(nameProblem(" ")).toBe("serve un nome")
    expect(nameProblem("../etc")).toBe("lettere, cifre, spazio, . _ -")
  })

  test("variables: shape, reserved, and one key per variable", () => {
    expect(envProblem("OPENAI_API_KEY")).toBeUndefined()
    expect(envProblem("openai")).toBe("maiuscole, cifre e _, es. OPENAI_API_KEY")
    expect(envProblem("PATH")).toBe("PATH è riservata")
    expect(envProblem("ADE_PANE_TOKEN")).toBe("ADE_PANE_TOKEN è riservata")
    const others = [key("OpenAI", "OPENAI_API_KEY", [])]
    expect(envProblem("OPENAI_API_KEY", others, "Altra")).toBe("OPENAI_API_KEY è già di un'altra chiave")
    expect(envProblem("OPENAI_API_KEY", others, "OpenAI")).toBeUndefined()
  })

  test("values are one line", () => {
    expect(valueProblem("sk-abc")).toBeUndefined()
    expect(valueProblem("sk-\nabc")).toBe("contiene un a capo: incollalo su una riga")
    expect(valueProblem("")).toBe("incolla il valore")
  })
})

describe("what the host refuses with, said in the interface's language (F7b)", () => {
  test("a code from the host becomes the page's sentence, in both languages", () => {
    expect(keyError("key.envReserved:PATH", "it")).toBe("PATH è riservata")
    expect(keyError("key.envReserved:PATH", "en")).toBe("PATH is reserved")
    expect(keyError("key.valueNewline", "en")).toBe("contains a line break; paste it on one line")
    expect(keyError("key.valueNewline", "it")).toBe("contiene un a capo: incollalo su una riga")
    expect(keyError("key.envTaken:OPENAI_API_KEY", "en")).toBe("OPENAI_API_KEY already belongs to another key")
    expect(keyError("key.notFound:GitHub", "en")).toBe("key «GitHub» not found")
    expect(keyError("key.notFound:GitHub", "it")).toBe("chiave «GitHub» non trovata")
    expect(keyError("key.keychain.refused", "en")).toContain("keychain")
  })

  test("every code the host sends has a sentence, none is shown raw", () => {
    const codes = [
      "key.nameInvalid",
      "key.envInvalid",
      "key.envReserved:PATH",
      "key.envTaken:X",
      "key.valueEmpty",
      "key.valueTooLong",
      "key.valueNewline",
      "key.valueNeeded",
      "key.editCancelled",
      "key.notFound:k",
      "key.noValue:k",
      ...["noAccess", "refused", "tooLong", "invalid", "ambiguous", "badEncoding", "noEntry", "other"].map(
        (kind) => `key.keychain.${kind}`,
      ),
    ]
    for (const code of codes) {
      for (const language of ["it", "en"] as const) {
        const said = keyError(code, language)
        expect(said.startsWith("key."), `${code} ${language}`).toBe(false)
        expect(said.length).toBeGreaterThan(3)
      }
    }
  })

  test("a message that is not a code passes through, and a code is read in a thrown value too", () => {
    expect(keyError("portachiavi non disponibile", "en")).toBe("portachiavi non disponibile")
    expect(keyError("key.somethingNew", "en")).toBe("key.somethingNew")
    expect(keyError("  key.valueEmpty\n", "it")).toBe(keyError("key.valueEmpty", "it"))
  })
})

describe("launch", () => {
  test("a session gets only the keys that name its agent, and none by default", () => {
    const keys = [
      key("Anthropic", "ANTHROPIC_API_KEY", []),
      key("OpenAI", "OPENAI_API_KEY", ["codex", "nikcli"]),
      key("Lost", "LOST_KEY", ["codex"], null),
    ]
    expect(keysForAgent(keys, "claude-code")).toEqual([])
    expect(keysForAgent(keys, "codex")).toEqual(["OpenAI"])
  })

  test("the variables that switch an agent to paid API use are called out", () => {
    expect(billingWarning("ANTHROPIC_API_KEY", "claude-code")).toBe(
      "Claude Code userà questa chiave invece dell'abbonamento Claude: consumo a pagamento",
    )
    expect(billingWarning("ANTHROPIC_API_KEY", "nikcli")).toBeUndefined()
    expect(billingWarning("OPENAI_API_KEY", "codex")).toContain("Codex")
  })

  test("a variable is suggested from the name", () => {
    expect(suggestEnv("OpenAI")).toBe("OPENAI_API_KEY")
    expect(suggestEnv("GitHub token")).toBe("GITHUB_TOKEN")
    expect(suggestEnv("stripe api")).toBe("STRIPE_API_KEY")
    expect(suggestEnv("1password")).toBe("_1PASSWORD_API_KEY")
    expect(addedLabel(0, 1)).toBe("")
    expect(addedLabel(1, 1 + 3 * 86_400_000)).toBe("aggiunta 3 giorni fa")
  })
})

describe("@ade keys", () => {
  const request = (verb: string, ...args: string[]) => ({ panel: "keys", verb, args, raw: "" })

  test("list says names, variables and agents, never a masked value", async () => {
    const outcome = await runKeysCommand(
      { list: async () => [key("OpenAI", "OPENAI_API_KEY", ["codex"])], ask: () => {} },
      request("list"),
    )
    expect(outcome).toEqual({ ok: true, detail: "OpenAI → OPENAI_API_KEY (codex)" })
    expect(JSON.stringify(outcome)).not.toContain("abcd")
  })

  test("ask opens the dialog with the variable and the reason", async () => {
    const asked: string[][] = []
    const controller = { list: async () => [], ask: (env: string, reason: string) => void asked.push([env, reason]) }
    expect(await runKeysCommand(controller, request("ask", "STRIPE_SECRET_KEY", "per", "i", "test"))).toMatchObject({
      ok: true,
    })
    expect(asked).toEqual([["STRIPE_SECRET_KEY", "per i test"]])
    expect(await runKeysCommand(controller, request("ask", "PATH"))).toEqual({
      ok: false,
      reason: "variabile: PATH è riservata",
    })
    expect(asked).toHaveLength(1)
  })
})
