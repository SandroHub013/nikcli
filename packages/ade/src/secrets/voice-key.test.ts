import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { codeOf } from "../test-support/source-text"
import type { KeyDraft, KeyInfo } from "./keys"
import {
  freeVoiceKeyName,
  migrateVoiceKey,
  resolveVoiceKeyConflict,
  saveVoiceKey,
  VOICE_KEY_ENV,
  type LegacyVoiceKey,
  type VoiceKeyHost,
} from "./voice-key"

/*
 * The voice's OpenRouter key leaves browser storage for the keychain (S6).
 * Only fakes here: a map for the keychain, a variable for the old slot. The
 * values are made up and never a real key.
 */

function fakeKeychain(initial: { name: string; env: string; value?: string; agents?: string[] }[] = []) {
  const entries = new Map(initial.map((entry) => [entry.name, { ...entry, agents: entry.agents ?? [] }]))
  const saves: KeyDraft[] = []
  let refuse: string | undefined
  const host: VoiceKeyHost = {
    list: async (): Promise<KeyInfo[]> =>
      [...entries.values()].map((entry) => ({
        name: entry.name,
        env: entry.env,
        agents: entry.agents,
        createdMs: 1,
        ...(entry.value ? { masked: `••••${entry.value.slice(-4)}` } : {}),
      })),
    save: async (draft) => {
      if (refuse) throw new Error(refuse)
      saves.push(draft)
      const before = entries.get(draft.name)
      entries.set(draft.name, {
        name: draft.name,
        env: draft.env,
        agents: [...draft.agents],
        value: draft.value ?? before?.value,
      })
    },
    remove: async (name) => {
      entries.delete(name)
    },
    read: async () => [...entries.values()].find((entry) => entry.env === VOICE_KEY_ENV)?.value,
  }
  return {
    host,
    saves,
    entries,
    refuseWith: (reason: string) => {
      refuse = reason
    },
  }
}

function fakeLegacy(value?: string): LegacyVoiceKey & { value: () => string | undefined } {
  let stored = value
  return {
    read: () => stored,
    clear: () => {
      stored = undefined
    },
    value: () => stored,
  }
}

describe("the voice's key moves into the keychain", () => {
  test("with no entry there, it is copied as «OpenRouter», to no agent, and then deleted from the browser", async () => {
    const keychain = fakeKeychain()
    const legacy = fakeLegacy("sk-or-finta-1111")
    expect(await migrateVoiceKey(keychain.host, legacy)).toEqual({ kind: "moved" })
    expect(keychain.saves).toEqual([{ name: "OpenRouter", env: VOICE_KEY_ENV, agents: [], value: "sk-or-finta-1111" }])
    expect(legacy.value()).toBeUndefined()
    expect(await keychain.host.read()).toBe("sk-or-finta-1111")
  })

  test("a refused save keeps the browser's copy, and says why", async () => {
    const keychain = fakeKeychain()
    keychain.refuseWith("portachiavi bloccato")
    const legacy = fakeLegacy("sk-or-finta-1111")
    expect(await migrateVoiceKey(keychain.host, legacy)).toEqual({ kind: "failed", reason: "portachiavi bloccato" })
    expect(legacy.value()).toBe("sk-or-finta-1111")
  })

  test("nothing in the browser is nothing to do", async () => {
    const keychain = fakeKeychain()
    expect(await migrateVoiceKey(keychain.host, fakeLegacy())).toEqual({ kind: "none" })
    expect(keychain.saves).toEqual([])
  })

  test("the same key already in the keychain: the browser's copy goes, nothing is saved", async () => {
    const keychain = fakeKeychain([{ name: "OR", env: VOICE_KEY_ENV, value: "sk-or-finta-1111" }])
    const legacy = fakeLegacy("sk-or-finta-1111")
    expect(await migrateVoiceKey(keychain.host, legacy)).toEqual({ kind: "same" })
    expect(keychain.saves).toEqual([])
    expect(legacy.value()).toBeUndefined()
  })

  test("a different key in the keychain: neither is chosen, and the question is asked once", async () => {
    const keychain = fakeKeychain([{ name: "OR", env: VOICE_KEY_ENV, value: "sk-or-finta-2222" }])
    const legacy = fakeLegacy("sk-or-finta-1111")
    expect(await migrateVoiceKey(keychain.host, legacy)).toEqual({ kind: "conflict" })
    expect(keychain.saves).toEqual([])
    expect(legacy.value()).toBe("sk-or-finta-1111")

    // «Usa quella della voce»: the entry keeps its name and agents, and takes the voice's value.
    await resolveVoiceKeyConflict(keychain.host, legacy, "voice")
    expect(keychain.saves).toEqual([{ name: "OR", env: VOICE_KEY_ENV, agents: [], value: "sk-or-finta-1111" }])
    expect(legacy.value()).toBeUndefined()
    // Answered: the next start finds nothing in the browser, and asks nothing.
    expect(await migrateVoiceKey(keychain.host, legacy)).toEqual({ kind: "none" })
  })

  test("«Tieni quella del portachiavi» drops the browser's copy and saves nothing", async () => {
    const keychain = fakeKeychain([{ name: "OR", env: VOICE_KEY_ENV, value: "sk-or-finta-2222" }])
    const legacy = fakeLegacy("sk-or-finta-1111")
    await resolveVoiceKeyConflict(keychain.host, legacy, "keychain")
    expect(keychain.saves).toEqual([])
    expect(legacy.value()).toBeUndefined()
    expect(await keychain.host.read()).toBe("sk-or-finta-2222")
  })

  test("an entry whose value the keychain lost is filled with the voice's key, keeping its agents", async () => {
    const keychain = fakeKeychain([{ name: "OR", env: VOICE_KEY_ENV, agents: ["codex"] }])
    const legacy = fakeLegacy("sk-or-finta-1111")
    expect(await migrateVoiceKey(keychain.host, legacy)).toEqual({ kind: "moved" })
    expect(keychain.saves).toEqual([{ name: "OR", env: VOICE_KEY_ENV, agents: ["codex"], value: "sk-or-finta-1111" }])
  })

  test("a key the user called «OpenRouter» for another variable is not overwritten", async () => {
    const keychain = fakeKeychain([{ name: "OpenRouter", env: "OPENROUTER_OTHER", value: "x-1111" }])
    expect(freeVoiceKeyName(await keychain.host.list())).toBe("OpenRouter 2")
    await saveVoiceKey(keychain.host, "sk-or-finta-3333")
    expect(keychain.entries.get("OpenRouter")?.env).toBe("OPENROUTER_OTHER")
    expect(keychain.entries.get("OpenRouter 2")?.env).toBe(VOICE_KEY_ENV)
  })
})

describe("lint: the wiring", () => {
  const workbench = codeOf(readFileSync(join(import.meta.dir, "../surface/workbench.tsx"), "utf8"))
  const shell = codeOf(readFileSync(join(import.meta.dir, "../host/shell.ts"), "utf8"))

  test("nikcli's key is copied into the keychain, not into the voice's settings", () => {
    expect(workbench).toContain(codeOf("await saveVoiceKey(host, copied)"))
    expect(workbench).not.toContain(
      codeOf("save: (key) => handleVoiceSettingsChange({ ...voiceSettings(), openRouterApiKey: key })"),
    )
    // Still behind the identity check and the user's removal.
    expect(workbench).toContain(codeOf("removed: isOpenRouterKeyRemoved"))
  })

  test("the page asks Rust for the voice's variable only", () => {
    expect(shell).toContain(codeOf('invoke<string | null>("secret_voice_key", { env: "OPENROUTER_API_KEY" })'))
  })

  test("a key the panel hands back never replaces the keychain's", () => {
    expect(workbench).toContain(codeOf("const saved = { ...stored, settings: withVoiceKey(stored.settings) }"))
  })
})
