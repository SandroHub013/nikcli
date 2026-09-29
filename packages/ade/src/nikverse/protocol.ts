/**
 * What ADE and the NikVerse world say to each other.
 *
 * The world runs in a frame with an origin of its own (`nikverse://localhost/`,
 * `http://nikverse.localhost/` on Windows), so it is treated as code that ADE
 * does not trust with anything it does not hand over. The line between them is
 * one `MessageChannel` port, offered once after the frame has loaded.
 *
 * - **ADE → world:** a snapshot (titles, states, kinds, projects, counters:
 *   nothing else, no transcript and no path), then events, and `pause` and
 *   `resume`.
 * - **world → ADE:** `ready`, and commands. A command is believed only when it
 *   is on the allowlist below, well formed, and about something the snapshot
 *   ADE sent contains. Anything else is ignored, and the reason is returned so
 *   it can be registered.
 */

import type { PaneState } from "../grid/pane-state"
import { readSpot, type PlayerSpot } from "./player"

export const PROTOCOL_VERSION = 1

/** The message that hands the world its port; the port travels with it. */
export const PORT_OFFER = "nikverse:port"

export interface Shop {
  /** Stable for a project (a hash of its folder): the same place every time. */
  id: string
  /** The sign. */
  name: string
  /** Its place around the square, given by ADE in the order projects were opened, and kept. */
  slot?: number
}

export interface Agent {
  paneId: string
  title: string
  /** The agent's id (`claude-code`, `codex`, `terminal`…). */
  kind: string
  /** The `id` of the shop it works in. */
  shop: string
  state: PaneState
  /** When it came to this state, in ms. */
  since: number
  /** How it looks, stable for a title. */
  look: { body: number; palette: number }
}

export interface Snapshot {
  at: number
  shops: Shop[]
  agents: Agent[]
  waiting: { decisions: number }
}

export type WorldEvent =
  | { type: "shop-open" | "shop-close"; shop: Shop }
  | { type: "agent-spawn" | "agent-close"; agent: Agent }
  | { type: "state"; paneId: string; state: PaneState; at: number }
  | { type: "waiting"; decisions: number }

/** ADE → world. */
export type ToWorld =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "event"; event: WorldEvent }
  | { type: "pause" }
  | { type: "resume" }
  /** Where the character stood last, given back when the world says `ready` (ADE keeps it, not the frame). */
  | ({ type: "player" } & PlayerSpot)
  /** Asked at every load of the frame: only the document that owns the port can answer. */
  | { type: "ping"; id: number }

/** world → ADE. */
export type FromWorld =
  | { type: "ready" }
  | { type: "pong"; id: number }
  | { type: "command"; command: unknown }
  /** Where the character is: sent when it stops and now and then while it walks, for ADE to keep. */
  | ({ type: "position" } & PlayerSpot)

export type Command =
  | { cmd: "open-session"; paneId: string }
  | { cmd: "focus-project"; project: string }
  | { cmd: "chord"; key: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }
  | { cmd: "release-focus" }

export type CommandName = Command["cmd"]

/**
 * What each command is allowed to be, and whether it needs the user's yes.
 *
 * A command that changes something asks in ADE's own DOM, never in the frame
 * (a page cannot be trusted to ask about itself). The four of this piece only
 * look, focus or run a shortcut the user could have pressed, so none asks yet;
 * `new-session` and `close-session` come in phase 2 with `confirm: true`.
 */
export const ALLOWLIST: Readonly<Record<CommandName, { confirm: boolean }>> = {
  "open-session": { confirm: false },
  "focus-project": { confirm: false },
  // Only with a modifier: a bare key is the world's own, and ADE's shortcuts all have one. ADE reads
  // it as one of its own bindings and runs the command only if it is navigation (`chords.ts`).
  chord: { confirm: false },
  "release-focus": { confirm: false },
}

const MAX_ID = 200
const MAX_KEY = 24

const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max

export type Parsed = { ok: true; command: Command } | { ok: false; reason: string }

/** A command from the world, if it is one ADE knows and it is well formed. */
export function parseCommand(raw: unknown): Parsed {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "il comando non è un oggetto" }
  const body = raw as Record<string, unknown>
  const name = body.cmd
  if (typeof name !== "string") return { ok: false, reason: "il comando non ha nome" }
  // `hasOwn`: "constructor" and "__proto__" are not commands.
  if (!Object.hasOwn(ALLOWLIST, name)) return { ok: false, reason: `comando sconosciuto: ${name.slice(0, 40)}` }
  switch (name as CommandName) {
    case "open-session":
      return text(body.paneId, MAX_ID)
        ? { ok: true, command: { cmd: "open-session", paneId: body.paneId } }
        : { ok: false, reason: "open-session senza una sessione valida" }
    case "focus-project":
      return text(body.project, MAX_ID)
        ? { ok: true, command: { cmd: "focus-project", project: body.project } }
        : { ok: false, reason: "focus-project senza un progetto valido" }
    case "release-focus":
      return { ok: true, command: { cmd: "release-focus" } }
    case "chord": {
      const flags = [body.ctrl, body.alt, body.shift, body.meta]
      if (!text(body.key, MAX_KEY) || flags.some((flag) => typeof flag !== "boolean"))
        return { ok: false, reason: "chord malformata" }
      if (!body.ctrl && !body.alt && !body.meta) return { ok: false, reason: "chord senza Ctrl, Alt o Meta" }
      return {
        ok: true,
        command: {
          cmd: "chord",
          key: body.key,
          ctrl: body.ctrl as boolean,
          alt: body.alt as boolean,
          shift: body.shift as boolean,
          meta: body.meta as boolean,
        },
      }
    }
  }
}

/** Whether the command is about something ADE showed the world: a session or project it does not know is ignored. */
export function vet(command: Command, snapshot: Snapshot | undefined): { ok: true } | { ok: false; reason: string } {
  if (command.cmd === "open-session") {
    return snapshot?.agents.some((agent) => agent.paneId === command.paneId)
      ? { ok: true }
      : { ok: false, reason: `open-session: sessione sconosciuta ${command.paneId.slice(0, 40)}` }
  }
  if (command.cmd === "focus-project") {
    return snapshot?.shops.some((shop) => shop.id === command.project)
      ? { ok: true }
      : { ok: false, reason: `focus-project: progetto sconosciuto ${command.project.slice(0, 40)}` }
  }
  return { ok: true }
}

/** What to do with a command that passed: run it, or ask first in ADE's own DOM. */
export function decide(command: Command): "run" | "confirm" {
  return ALLOWLIST[command.cmd].confirm ? "confirm" : "run"
}

/** A whole message from the world, read defensively: anything that is not one of its two shapes is nothing. */
export function readFromWorld(data: unknown): FromWorld | undefined {
  if (!data || typeof data !== "object") return undefined
  const body = data as { type?: unknown; command?: unknown; id?: unknown }
  if (body.type === "ready") return { type: "ready" }
  if (body.type === "pong") return typeof body.id === "number" ? { type: "pong", id: body.id } : undefined
  if (body.type === "command") return { type: "command", command: body.command }
  if (body.type === "position") {
    const spot = readSpot(data)
    return spot ? { type: "position", ...spot } : undefined
  }
  return undefined
}

export const NIKVERSE_SCHEME = "nikverse"

const isWindowsWebview = () => typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)

/**
 * Where the world is served from. WebView2 answers a custom scheme only as
 * `http://<scheme>.localhost`, the other webviews as `<scheme>://localhost`
 * (the same rule as `mediaUrl`). The frame's own origin is opaque (it is
 * sandboxed without `allow-same-origin`), so this is where its files come from,
 * not what it is.
 */
export function worldOrigin(windows = isWindowsWebview()): string {
  return windows ? `http://${NIKVERSE_SCHEME}.localhost` : `${NIKVERSE_SCHEME}://localhost`
}

export function worldUrl(windows = isWindowsWebview()): string {
  return `${worldOrigin(windows)}/`
}
