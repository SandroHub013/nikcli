/**
 * What sessions share besides messages: a key-value store for state, a memory
 * file for knowledge, and the numbers that say whether the prompt cache is
 * doing its job.
 *
 * All three are kept out of every prompt until an agent asks for them. That is
 * the rule that makes them cheap: text that enters a session's instructions
 * changes its prefix and costs the cache, while the output of a command lands
 * at the end of the conversation and costs only itself.
 *
 * Pure, like `mailbox.ts`; the workbench does the storing and the files.
 */
import type { KvOpName } from "./mailbox"

// -- key-value store ---------------------------------------------------------

export interface KvEntry {
  value: string
  /** Title of the session that wrote it, as it was then. */
  by: string
  at: number
}

export interface KvLock {
  owner: string
  ownerTitle: string
  until: number
  note?: string
}

/** One project's store. */
export interface KvSpace {
  entries: Record<string, KvEntry>
  locks: Record<string, KvLock>
}

export const KV_MAX_KEYS = 200
export const KV_MAX_VALUE = 4000
export const KV_DEFAULT_TTL = 600
export const KV_MAX_TTL = 4 * 3600

export function emptySpace(): KvSpace {
  return { entries: {}, locks: {} }
}

/** The one space of the machine: what a key starting with `pc:` lives in, whatever the project of who asks. */
export const KV_MACHINE_SPACE = "__pc__"

/**
 * Where a key lives. A lock on what the machine has once (ADE Test, the bench, a GPU) must be one for every project, so the keys
 * that start with `pc:` (`pc:ade-test`, `pc:sweep`) share one space; every other key is in the project of who asks, as it always was.
 */
export function kvSpaceFor(key: string, senderProject: string | undefined, uiProject: string | undefined): string {
  return key.startsWith("pc:") ? KV_MACHINE_SPACE : senderProject || uiProject || "workspace"
}

/** Said in the reply of a lock, so a lock that does not hold across projects is seen at once. */
export function kvScopeLabel(space: string): string {
  return space === KV_MACHINE_SPACE ? "su tutta la macchina" : `nel progetto ${space}`
}

/**
 * `applyKv` over the whole store: picks the space of the key (`kvSpaceFor`), and shows a listing the project's keys together with
 * the machine's, so anyone sees who holds `pc:ade-test`. Returns the store with the space that changed.
 */
export function applyKvAcross(
  store: Record<string, KvSpace>,
  projects: { sender?: string; ui?: string },
  request: KvRequest,
  who: KvWho | undefined,
  now: number,
  alive: (paneId: string) => boolean,
): { store: Record<string, KvSpace>; reply: string } {
  const name = kvSpaceFor(request.key, projects.sender, projects.ui)
  const space = store[name] ?? emptySpace()
  if (request.op === "list" && name !== KV_MACHINE_SPACE) {
    const machine = store[KV_MACHINE_SPACE] ?? emptySpace()
    const merged: KvSpace = {
      // The machine wins: an old pc: key left in a project's space (taken before the prefix existed) must not hide the real one.
      entries: { ...space.entries, ...machine.entries },
      locks: { ...space.locks, ...machine.locks },
    }
    return { store, reply: applyKv(merged, request, who, now, alive).reply }
  }
  const result = applyKv(space, request, who, now, alive, kvScopeLabel(name))
  return { store: result.space === store[name] ? store : { ...store, [name]: result.space }, reply: result.reply }
}

/**
 * A value of `record` only if it is the record's own: `isKvKey` accepts `constructor`, `toString` and `__proto__`, and a
 * plain `record[key]` answers those with a function or the prototype (full review 2026-10-06, sessions 17).
 */
function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

export function isKvKey(key: string): boolean {
  return /^[A-Za-z0-9._:/-]{1,80}$/.test(key)
}

export interface KvRequest {
  op: KvOpName
  key: string
  value: string
  ttl: number
  force: boolean
}

export interface KvWho {
  id: string
  title: string
}

/**
 * Applies one operation. `reply` starts with `ok` or `errore`; for reads the
 * value follows on the next line, which `ade-msg` prints on its own.
 *
 * Writes need a proven sender — an anonymous one could not be told apart from
 * another session — and a lock held by a live session can only be released by
 * it, or with `force`. A lock whose owner is gone, or whose time is up, is free.
 */
export function applyKv(
  space: KvSpace,
  request: KvRequest,
  who: KvWho | undefined,
  now: number,
  alive: (paneId: string) => boolean,
  /** Where the space holds, for the reply of a lock (`kvScopeLabel`). */
  where?: string,
): { space: KvSpace; reply: string } {
  const { op, key } = request
  if (op !== "list" && !isKvKey(key)) {
    return { space, reply: "errore: chiave non valida (lettere, cifre e . _ : / -, al massimo 80)" }
  }
  const held = (name: string) => {
    const lock = own(space.locks, name)
    return lock && lock.until > now && alive(lock.owner) ? lock : undefined
  }

  switch (op) {
    case "get": {
      const entry = own(space.entries, key)
      if (!entry) return { space, reply: `errore: nessun valore per ${key}` }
      return { space, reply: `ok\n${entry.value}` }
    }
    case "list": {
      const prefix = key
      const names = Object.keys(space.entries)
        .filter((name) => name.startsWith(prefix))
        .sort()
      const lockNames = Object.keys(space.locks)
        .filter((name) => name.startsWith(prefix) && held(name))
        .sort()
      if (names.length === 0 && lockNames.length === 0) return { space, reply: "ok\n(vuoto)" }
      const lines = names.map((name) => {
        const entry = space.entries[name]!
        const oneLine = entry.value.replace(/\s+/g, " ")
        return `${name} = ${oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine}  (${entry.by}, ${age(now - entry.at)})`
      })
      for (const name of lockNames) {
        const lock = space.locks[name]!
        lines.push(
          `lock ${name}: ${lock.ownerTitle}, scade tra ${age(lock.until - now)}${lock.note ? ` — ${lock.note}` : ""}`,
        )
      }
      return { space, reply: `ok\n${lines.join("\n")}` }
    }
    case "set": {
      if (!who) return { space, reply: "errore: scrivere richiede una sessione avviata da ADE" }
      if (request.value.length > KV_MAX_VALUE) {
        return {
          space,
          reply: `errore: valore oltre ${KV_MAX_VALUE} caratteri: mettilo in un file e salva il percorso`,
        }
      }
      if (!own(space.entries, key) && Object.keys(space.entries).length >= KV_MAX_KEYS) {
        return { space, reply: `errore: lo store ha già ${KV_MAX_KEYS} chiavi: cancellane qualcuna con ade-msg kv del` }
      }
      const lock = held(key)
      if (lock && lock.owner !== who.id) return { space, reply: `errore: ${key} è bloccata da "${lock.ownerTitle}"` }
      const next = { ...space, entries: { ...space.entries, [key]: { value: request.value, by: who.title, at: now } } }
      return { space: next, reply: `ok: ${key} salvata` }
    }
    case "del": {
      if (!who) return { space, reply: "errore: scrivere richiede una sessione avviata da ADE" }
      const lock = held(key)
      if (lock && lock.owner !== who.id) return { space, reply: `errore: ${key} è bloccata da "${lock.ownerTitle}"` }
      if (!own(space.entries, key)) return { space, reply: `ok: ${key} non c'era` }
      const entries = { ...space.entries }
      delete entries[key]
      return { space: { ...space, entries }, reply: `ok: ${key} cancellata` }
    }
    case "lock": {
      if (!who) return { space, reply: "errore: un lock richiede una sessione avviata da ADE" }
      const lock = held(key)
      if (lock && lock.owner !== who.id) {
        return {
          space,
          reply: `errore: ${key} è già bloccata da "${lock.ownerTitle}" per ${age(lock.until - now)}${lock.note ? ` (${lock.note})` : ""}`,
        }
      }
      const ttl = Math.min(KV_MAX_TTL, request.ttl > 0 ? request.ttl : KV_DEFAULT_TTL)
      const note = request.value.trim().slice(0, 200)
      const locks = {
        ...space.locks,
        [key]: { owner: who.id, ownerTitle: who.title, until: now + ttl * 1000, ...(note ? { note } : {}) },
      }
      return {
        space: { ...space, locks },
        reply: `ok: ${key} bloccata per ${age(ttl * 1000)}${where ? ` ${where}` : ""}; rilasciala con ade-msg kv unlock ${key}`,
      }
    }
    case "unlock": {
      if (!who) return { space, reply: "errore: un lock richiede una sessione avviata da ADE" }
      const lock = held(key)
      if (lock && lock.owner !== who.id && !request.force) {
        return {
          space,
          reply: `errore: ${key} è bloccata da "${lock.ownerTitle}"; solo lei può rilasciarla (o --force)`,
        }
      }
      if (!own(space.locks, key)) return { space, reply: `ok: ${key} non era bloccata` }
      const locks = { ...space.locks }
      delete locks[key]
      return { space: { ...space, locks }, reply: `ok: ${key} rilasciata` }
    }
  }
}

function age(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`
}

/** A saved store read back; anything malformed is dropped rather than trusted. */
export function parseKvStore(raw: string | null): Record<string, KvSpace> {
  if (!raw) return {}
  try {
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== "object") return {}
    const out: Record<string, KvSpace> = {}
    for (const [project, space] of Object.entries(value as Record<string, unknown>)) {
      if (!space || typeof space !== "object") continue
      const { entries, locks } = space as { entries?: unknown; locks?: unknown }
      const cleanEntries: [string, KvEntry][] = []
      const cleanLocks: [string, KvLock][] = []
      for (const [key, entry] of Object.entries((entries as Record<string, unknown>) ?? {})) {
        const e = entry as Partial<KvEntry>
        if (isKvKey(key) && typeof e?.value === "string" && typeof e.by === "string" && typeof e.at === "number") {
          cleanEntries.push([key, { value: e.value, by: e.by, at: e.at }])
        }
      }
      for (const [key, lock] of Object.entries((locks as Record<string, unknown>) ?? {})) {
        const l = lock as Partial<KvLock>
        if (
          isKvKey(key) &&
          typeof l?.owner === "string" &&
          typeof l.ownerTitle === "string" &&
          typeof l.until === "number"
        ) {
          cleanLocks.push([
            key,
            {
              owner: l.owner,
              ownerTitle: l.ownerTitle,
              until: l.until,
              ...(typeof l.note === "string" ? { note: l.note } : {}),
            },
          ])
        }
      }
      // `fromEntries` defines own keys; `clean[key] = …` with `__proto__` would have set the prototype and lost the key.
      out[project] = { entries: Object.fromEntries(cleanEntries), locks: Object.fromEntries(cleanLocks) }
    }
    return out
  } catch {
    return {}
  }
}

// -- memory ------------------------------------------------------------------

export const MEMORY_TYPES = ["decisione", "fatto", "trappola", "todo"] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

/** Past this the file is costing every session that reads it; ADE says so. */
export const MEMORY_SOFT_LIMIT = 12_000
export const MEMORY_MAX_ENTRY = 500

export const MEMORY_HEADER =
  "# Memoria condivisa del progetto\n\n" +
  "Scritta dalle sessioni di ADE con `ade-msg memory add <tipo> <testo>`. Solo fatti stabili che valgono per tutti:\n" +
  "decisioni prese, convenzioni, comandi di build e test, trappole scoperte. I dettagli di un compito vanno nel suo\n" +
  "risultato in `.ade/results/`, qui al massimo il percorso.\n\n"

function pad(n: number): string {
  return String(n).padStart(2, "0")
}

/**
 * One entry, or why it is refused. On one line: the file is read by agents
 * and by people, and a paragraph in it is something neither skims.
 */
export function memoryEntry(
  type: string,
  text: string,
  author: string,
  at: Date,
): { line: string } | { error: string } {
  const kind = MEMORY_TYPES.find((known) => known === type.trim().toLowerCase())
  if (!kind) return { error: `tipo non valido: ${type} (usa ${MEMORY_TYPES.join(", ")})` }
  const body = text.replace(/\s+/g, " ").trim()
  if (!body) return { error: "voce vuota" }
  if (body.length > MEMORY_MAX_ENTRY) {
    return { error: `voce oltre ${MEMORY_MAX_ENTRY} caratteri: scrivi i dettagli in un file e qui il percorso` }
  }
  const when = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
  return { line: `- [${kind}] ${body} — ${author.replace(/\s+/g, " ").trim() || "sessione"}, ${when}\n` }
}

/** The file with `line` appended; the header written the first time. */
export function withMemoryEntry(current: string, line: string): string {
  const base = current.trim() ? (current.endsWith("\n") ? current : `${current}\n`) : MEMORY_HEADER
  return `${base}${line}`
}

/** The receipt for an added entry, with a warning once the file is getting expensive. */
export function memoryAddReply(path: string, size: number): string {
  const warning =
    size > MEMORY_SOFT_LIMIT
      ? `\nattenzione: la memoria supera ${MEMORY_SOFT_LIMIT} caratteri e ogni sessione la paga leggendola: compattala togliendo le voci superate`
      : ""
  return `ok\nvoce aggiunta a ${path}${warning}`
}

// -- cache usage -------------------------------------------------------------

/** Mirrors `Usage` in `src-tauri/src/usage.rs`. */
export interface TokenUsage {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  requests: number
}

/** Share of the prompt that came from the cache, 0-100, or undefined with no prompt yet. */
export function cacheHitPercent(usage: TokenUsage): number | undefined {
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite
  return prompt > 0 ? Math.round((usage.cacheRead / prompt) * 100) : undefined
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** What `ade-msg stats` prints. */
export function statsTable(
  rows: readonly { title: string; agent: string; project?: string; usage: TokenUsage }[],
): string {
  if (rows.length === 0) return "nessun dato di consumo: servono sessioni claude o codex con una conversazione salvata"
  const total: TokenUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: 0 }
  const lines = ["cache  letti   scritti  pieni   output  richieste  sessione"]
  for (const row of rows) {
    const u = row.usage
    total.input += u.input
    total.cacheRead += u.cacheRead
    total.cacheWrite += u.cacheWrite
    total.output += u.output
    total.requests += u.requests
    const hit = cacheHitPercent(u)
    lines.push(
      `${(hit === undefined ? "—" : `${hit}%`).padEnd(6)} ${compact(u.cacheRead).padEnd(7)} ${compact(u.cacheWrite).padEnd(8)} ${compact(u.input).padEnd(7)} ${compact(u.output).padEnd(7)} ${String(u.requests).padEnd(10)} ${row.project ? `${row.project}/` : ""}${row.title} (${row.agent})`,
    )
  }
  const hit = cacheHitPercent(total)
  lines.push(
    `${(hit === undefined ? "—" : `${hit}%`).padEnd(6)} ${compact(total.cacheRead).padEnd(7)} ${compact(total.cacheWrite).padEnd(8)} ${compact(total.input).padEnd(7)} ${compact(total.output).padEnd(7)} ${String(total.requests).padEnd(10)} totale`,
  )
  lines.push("cache = quota del prompt letta dalla cache; pieni = token pagati a prezzo intero")
  return lines.join("\n")
}
