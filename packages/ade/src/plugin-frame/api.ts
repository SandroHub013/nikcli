/**
 * What ADE and a plugin in a frame say to each other: API v1.
 *
 * A plugin runs in a sandboxed frame with an opaque origin, so ADE trusts it with nothing it does not hand over. The line between the two is
 * one `MessageChannel` port (`handshake.ts`, `link.ts`), and every message on it is an envelope `{v: 1, id?, type, …}`.
 *
 * - **plugin → ADE:** `ready`, `pong`, and requests. A request with an `id` is answered `{type: "reply", id, ok, value | error}`; one without
 *   `id` gets no reply unless it is refused, and then an `{type: "error", error}`.
 * - **ADE → plugin:** `hello`, then whatever the plugin was granted (`sessions.snapshot`, `sessions.event`, `projects`, `decisions.count`),
 *   `pause` and `resume`, and `ping`.
 *
 * Every incoming message goes through, in this order: the rate cap (a plugin that floods costs ADE one counter and one warning, and is not
 * answered), the schema, then the permission. What is refused is answered with the reason and does nothing.
 */

export const API_VERSION = 1

/** What a plugin may ask ADE for. A manifest names them; the user accepts them in ADE's own DOM. */
export const PERMISSIONS = [
  "sessions:read",
  "projects:read",
  "decisions:count",
  "pane:focus",
  "command:navigation",
  "storage",
] as const
export type Permission = (typeof PERMISSIONS)[number]

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value)
}

/** The permissions of a manifest that ADE knows: an unknown one grants nothing. */
export function knownPermissions(names: readonly unknown[]): Permission[] {
  return [...new Set(names.filter(isPermission))]
}

/** One request a plugin can make, and the permission it needs (none: anyone may). */
export const REQUESTS = {
  "sessions.snapshot": { permission: "sessions:read" },
  projects: { permission: "projects:read" },
  "decisions.count": { permission: "decisions:count" },
  "pane.focus": { permission: "pane:focus" },
  "command.run": { permission: "command:navigation" },
  "focus.release": { permission: undefined },
  "storage.get": { permission: "storage" },
  "storage.set": { permission: "storage" },
} as const satisfies Record<string, { permission: Permission | undefined }>

export type RequestName = keyof typeof REQUESTS

/** A chord a plugin asks ADE to press: read as one of ADE's own bindings and run only if it is navigation (`navigation.ts`). */
export interface Chord {
  key: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

export type Request =
  | { name: "sessions.snapshot" }
  | { name: "projects" }
  | { name: "decisions.count" }
  | { name: "pane.focus"; paneId: string }
  | { name: "command.run"; chord: Chord }
  | { name: "focus.release" }
  | { name: "storage.get" }
  | { name: "storage.set"; value: unknown }

export type RequestId = number | string

export type Incoming =
  | { kind: "ready" }
  | { kind: "pong"; id: number }
  | { kind: "request"; id: RequestId | undefined; request: Request }

export type Parsed = { ok: true; incoming: Incoming } | { ok: false; reason: string; id?: RequestId }

/** The most a plugin's storage may hold: the size of its JSON, in bytes. */
export const MAX_STORAGE_BYTES = 1_000_000
const MAX_ID = 200
const MAX_KEY = 24
const MAX_TEXT_ID = 64

const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max

function readId(value: unknown): RequestId | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : undefined
  return text(value, MAX_TEXT_ID) ? value : undefined
}

function readChord(raw: unknown): Chord | string {
  if (!raw || typeof raw !== "object") return "chord malformata"
  const body = raw as Record<string, unknown>
  const flags = [body.ctrl, body.alt, body.shift, body.meta]
  if (!text(body.key, MAX_KEY) || flags.some((flag) => typeof flag !== "boolean")) return "chord malformata"
  // A bare key is the plugin's own, and ADE's shortcuts all have a modifier.
  if (!body.ctrl && !body.alt && !body.meta) return "chord senza Ctrl, Alt o Meta"
  return { key: body.key, ctrl: body.ctrl as boolean, alt: body.alt as boolean, shift: body.shift as boolean, meta: body.meta as boolean }
}

/** A message from the plugin, if it is one ADE knows and it is well formed. Read defensively: nothing here throws. */
export function parseIncoming(raw: unknown): Parsed {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "il messaggio non è un oggetto" }
  const body = raw as Record<string, unknown>
  const id = readId(body.id)
  const refuse = (reason: string): Parsed => (id === undefined ? { ok: false, reason } : { ok: false, reason, id })
  if (body.v !== API_VERSION) return refuse("versione dell'API mancante o non supportata")
  const type = body.type
  if (typeof type !== "string") return refuse("il messaggio non ha un tipo")
  if (type === "ready") return { ok: true, incoming: { kind: "ready" } }
  if (type === "pong") return typeof body.id === "number" ? { ok: true, incoming: { kind: "pong", id: body.id } } : refuse("pong senza id")
  // `hasOwn`: "constructor" and "__proto__" are not requests.
  if (!Object.hasOwn(REQUESTS, type)) return refuse(`messaggio sconosciuto: ${type.slice(0, 40)}`)
  const name = type as RequestName
  const request = (request: Request): Parsed => ({ ok: true, incoming: { kind: "request", id, request } })
  switch (name) {
    case "sessions.snapshot":
    case "projects":
    case "decisions.count":
    case "focus.release":
    case "storage.get":
      return request({ name })
    case "pane.focus":
      return text(body.paneId, MAX_ID) ? request({ name, paneId: body.paneId }) : refuse("pane.focus senza una sessione valida")
    case "command.run": {
      const chord = readChord(body.chord)
      return typeof chord === "string" ? refuse(chord) : request({ name, chord })
    }
    case "storage.set":
      return Object.hasOwn(body, "value") ? request({ name, value: body.value }) : refuse("storage.set senza value")
  }
}

/** Why a request is refused for want of a permission, or nothing when it may go on. */
export function authorize(name: RequestName, granted: readonly Permission[]): string | undefined {
  const needed: Permission | undefined = REQUESTS[name].permission
  return needed === undefined || granted.includes(needed) ? undefined : `permesso mancante: ${needed}`
}

/** The JSON of a value bound for storage, or why it cannot be stored. */
export function storable(value: unknown): { ok: true; json: string } | { ok: false; reason: string } {
  let json: string | undefined
  try {
    json = JSON.stringify(value)
  } catch {
    return { ok: false, reason: "il valore non è JSON" }
  }
  if (json === undefined) return { ok: false, reason: "il valore non è JSON" }
  const bytes = new TextEncoder().encode(json).length
  return bytes > MAX_STORAGE_BYTES
    ? { ok: false, reason: `il valore pesa ${bytes} byte: il tetto è ${MAX_STORAGE_BYTES}` }
    : { ok: true, json }
}

/** A cap on how many messages a plugin may send: a fixed window, with the clock given. */
export const MAX_MESSAGES_PER_SECOND = 50

export function createRateLimit(now: () => number, max = MAX_MESSAGES_PER_SECOND, windowMs = 1000) {
  let start = -Infinity
  let count = 0
  let warned = false
  return {
    /** `ok`: handle it. `drop`: over the cap, ignore it. `first-drop`: over the cap for the first time in this window, say so once. */
    admit(): "ok" | "drop" | "first-drop" {
      const at = now()
      if (at - start >= windowMs || at < start) {
        start = at
        count = 0
        warned = false
      }
      count++
      if (count <= max) return "ok"
      if (warned) return "drop"
      warned = true
      return "first-drop"
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// What ADE sends
// ---------------------------------------------------------------------------------------------------------------------------------

export interface SessionInfo {
  paneId: string
  title: string
  /** The agent's id (`claude-code`, `codex`, `terminal`…). */
  kind: string
  /** The opaque id of its project (`ProjectInfo.id`), never a path. */
  project: string
  state: string
  /** When it came to this state, in ms. */
  since: number
}

export interface SessionsSnapshot {
  at: number
  sessions: SessionInfo[]
}

export type SessionEvent =
  | { type: "open" | "close"; session: SessionInfo }
  | { type: "state"; paneId: string; state: string; at: number }

export interface ProjectInfo {
  /** A hash of the folder with a salt of this plugin's own: the same for this plugin every time, different for every other. */
  id: string
  name: string
}

export interface HelloInfo {
  locale: string
  theme: string
  reducedMotion: boolean
}

export type ToPlugin =
  | ({ type: "hello"; api: number; granted: Permission[] } & HelloInfo)
  | { type: "sessions.snapshot"; snapshot: SessionsSnapshot }
  | { type: "sessions.event"; event: SessionEvent }
  | { type: "projects"; projects: ProjectInfo[] }
  | { type: "decisions.count"; count: number }
  | { type: "pause" }
  | { type: "resume" }
  /** Asked at every load of the frame: only the document that owns the port can answer. */
  | { type: "ping"; id: number }
  | { type: "reply"; id: RequestId; ok: true; value: unknown }
  | { type: "reply"; id: RequestId; ok: false; error: string }
  | { type: "error"; error: string }

/** The envelope of everything ADE sends. */
export function envelope(message: ToPlugin): { v: number } & ToPlugin {
  return { v: API_VERSION, ...message }
}
