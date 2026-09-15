/**
 * The API keys the user keeps in ADE: what the page knows about them, and
 * which of them a session gets when it starts.
 *
 * The values are never here. They live in the system keychain and only Rust
 * reads them (`src-tauri/src/secrets.rs`); this side handles names, the
 * variable each becomes, the agents allowed to receive it, and a masked tail
 * for recognising one key from another.
 *
 * Plain `.ts`, so the rules are tested under `bun test`.
 */

import type { PanelOutcome, PanelRequest } from "../panels/protocol"

export interface KeyInfo {
  readonly name: string
  readonly env: string
  /** Agent ids that receive it at launch; empty means none. */
  readonly agents: readonly string[]
  readonly createdMs: number
  /** `••••••••abcd`; undefined when the keychain lost the value. */
  readonly masked?: string
}

export interface KeyDraft {
  readonly name: string
  readonly env: string
  readonly agents: readonly string[]
  /** Undefined when editing and the value stays as it is. */
  readonly value?: string
}

/** Mirrors `check_name` in `secrets.rs`, so the form can say so before saving. */
export function nameProblem(name: string): string | undefined {
  const trimmed = name.trim()
  if (!trimmed) return "serve un nome"
  if (trimmed.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(trimmed)) return "lettere, cifre, spazio, . _ -"
  return undefined
}

const RESERVED_ENV = new Set([
  "PATH", "PATHEXT", "TERM", "COLORTERM", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP", "SHELL", "PWD", "LD_PRELOAD",
  "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS",
])

/** Mirrors `check_env` in `secrets.rs`. */
export function envProblem(env: string, others: readonly KeyInfo[] = [], name = ""): string | undefined {
  const trimmed = env.trim()
  if (!trimmed) return "serve il nome della variabile"
  if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(trimmed)) return "maiuscole, cifre e _, es. OPENAI_API_KEY"
  if (RESERVED_ENV.has(trimmed) || trimmed.startsWith("ADE_")) return `${trimmed} è riservata`
  if (others.some((key) => key.env === trimmed && key.name !== name.trim())) return `${trimmed} è già di un'altra chiave`
  return undefined
}

/** Mirrors `check_value` in `secrets.rs`. */
export function valueProblem(value: string): string | undefined {
  if (!value.trim()) return "incolla il valore"
  if (value.length > 4096) return "troppo lungo (massimo 4096 caratteri)"
  if (/[\0\r\n]/.test(value)) return "contiene un a capo: incollalo su una riga"
  return undefined
}

/** `OpenAI key` → `OPENAI_API_KEY`: a starting point the user can change. */
export function suggestEnv(name: string): string {
  const base = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "_$1")
  if (!base) return ""
  if (/(_KEY|_TOKEN|_SECRET)$/.test(base)) return base
  return `${base.replace(/_API$/, "")}_API_KEY`
}

/** The names of the keys `agentId` gets at launch. */
export function keysForAgent(keys: readonly KeyInfo[], agentId: string): string[] {
  return keys.filter((key) => key.masked !== undefined && key.agents.includes(agentId)).map((key) => key.name)
}

/**
 * Variables that change how an agent is billed or signed in, not just what it
 * can reach. Claude Code with `ANTHROPIC_API_KEY` in its environment uses the
 * key instead of the subscription; codex with `OPENAI_API_KEY` likewise.
 */
const BILLING_SWITCH: Record<string, { agent: string; label: string; account: string }> = {
  ANTHROPIC_API_KEY: { agent: "claude-code", label: "Claude Code", account: "dell'abbonamento Claude" },
  OPENAI_API_KEY: { agent: "codex", label: "Codex", account: "dell'accesso ChatGPT" },
}

/** The warning to show next to an agent that would switch to paid API use. */
export function billingWarning(env: string, agentId: string): string | undefined {
  const rule = BILLING_SWITCH[env.trim()]
  if (!rule || rule.agent !== agentId) return undefined
  return `${rule.label} userà questa chiave invece ${rule.account}: consumo a pagamento`
}

/* What an agent can ask for with `@ade keys …`. */

export const KEYS_VERBS = [
  { name: "list", usage: "list", summary: "elenca le chiavi salvate: nome, variabile e agenti, mai il valore" },
  {
    name: "ask",
    usage: "ask <NOME_VARIABILE> [motivo]",
    summary: "chiede all'utente di salvare una chiave; arriva alla sessione al prossimo avvio",
  },
] as const

export interface KeysController {
  list(): Promise<readonly KeyInfo[]>
  /** Opens the request dialog; resolves once it is on screen. */
  ask(env: string, reason: string): void
}

export async function runKeysCommand(controller: KeysController, request: PanelRequest): Promise<PanelOutcome> {
  if (request.verb === "list") {
    const keys = await controller.list()
    if (keys.length === 0) return { ok: true, detail: "nessuna chiave salvata" }
    return {
      ok: true,
      detail: keys
        .map((key) => `${key.name} → ${key.env} (${key.agents.length > 0 ? key.agents.join(", ") : "a nessun agente"})`)
        .join("; "),
    }
  }
  if (request.verb === "ask") {
    const [env = "", ...rest] = request.args
    const problem = envProblem(env)
    if (problem) return { ok: false, reason: `variabile: ${problem}` }
    const keys = await controller.list()
    const existing = keys.find((key) => key.env === env)
    controller.ask(env, rest.join(" ").trim())
    return {
      ok: true,
      detail: existing
        ? `${env} esiste già come «${existing.name}»: chiesto all'utente di darla a questo agente; vale dal prossimo avvio della sessione`
        : `chiesto all'utente di salvare ${env}; vale dal prossimo avvio della sessione, il valore non passa da qui`,
    }
  }
  return { ok: false, reason: `verbo sconosciuto: ${request.verb}` }
}

/** "3 giorni fa", "oggi": when a key was added. */
export function addedLabel(createdMs: number, now: number): string {
  if (!createdMs) return ""
  const days = Math.floor((now - createdMs) / 86_400_000)
  if (days <= 0) return "aggiunta oggi"
  if (days === 1) return "aggiunta ieri"
  return `aggiunta ${days} giorni fa`
}
