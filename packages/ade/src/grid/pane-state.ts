import type { SessionQuota } from "../session/quota"
import { t } from "../i18n"
import { activityLabel, normalizeActivity } from "./activity"

/*
 * `provisioning` comes before `working`: the worktree checkout runs for seconds
 * before the process starts, and a card stuck on `waiting` there reads as
 * "needs an answer" — which this session is not asking for.
 */
export type PaneStatus = "idle" | "provisioning" | "working" | "waiting" | "done" | "error"

/**
 * THE list of session states. The sidebar's icon, the pane's chip and their
 * colours (`--ade-state-*` in index.css) all read it: a state added here needs
 * its two words in the i18n sheets, its colour token and its shape in
 * `state-icon.tsx`, and a test (`state-list.test.ts`) fails until it has them.
 *
 * The canonical session states for Proposal A header, `off`, a suspended
 * session (P1-C6), and `closed`, one whose process ended well. Neither has a
 * process, asks anything or moves.
 */
export const STATE_IDS = ["work", "perm", "ask", "err", "limit", "idle", "off", "closed"] as const
export type PaneState = (typeof STATE_IDS)[number]

/* Getters, so each read is in the language of that moment (S41). */
export const STATE_FULL: Readonly<Record<PaneState, string>> = {
  get work() {
    return t("paneState.work")
  },
  get perm() {
    return t("paneState.perm")
  },
  get ask() {
    return t("paneState.ask")
  },
  get err() {
    return t("paneState.err")
  },
  get limit() {
    return t("paneState.limit")
  },
  get idle() {
    return t("paneState.idle")
  },
  get off() {
    return t("paneState.off")
  },
  get closed() {
    return t("paneState.closed")
  },
}

export const STATE_SHORT: Readonly<Record<PaneState, string>> = {
  get work() {
    return t("paneState.work")
  },
  get perm() {
    return t("paneState.short.perm")
  },
  get ask() {
    return t("paneState.short.ask")
  },
  get err() {
    return t("paneState.err")
  },
  get limit() {
    return t("paneState.short.limit")
  },
  get idle() {
    return t("paneState.idle")
  },
  get off() {
    return t("paneState.off")
  },
  get closed() {
    return t("paneState.closed")
  },
}

/**
 * Maps incoming status, activity, quota, and pending actions into one of the 6 canonical states:
 * - work: active agent task (working, provisioning)
 * - perm: waiting for user permission or interactive prompt action
 * - ask: waiting on another session (e.g. ade-msg ask)
 * - err: agent process failed or exited with error
 * - limit: provider quota rate limited or exhausted
 * - idle: prompt ready, agent waiting for instruction
 * - off: suspended by the user; checked before the pending actions, since
 *   its one button is "Riprendi", which is not a question being asked
 * - closed: the process is gone and ended well; before the actions for the
 *   same reason, its button being "Riprendi"
 *
 * Limit is checked after permission and work, not before. The quota is the
 * provider's, shared by every session on it; a permission prompt or a running
 * turn is this session's own, and it is what the user has to act on or wait
 * for. Ranking Limit first made every Codex pane read "Limite" while it was
 * asking to run a command.
 */
export function resolvePaneState(props: {
  status?: PaneStatus
  state?: PaneState
  activity?: string
  quota?: SessionQuota
  hasActions?: boolean
  /** No process behind the pane any more. */
  exited?: boolean
}): PaneState {
  if (props.state) return props.state
  if (props.activity !== undefined && normalizeActivity(props.activity) === "suspended") return "off"
  if (props.status === "error") return "err"
  if (props.exited && props.status === "done") return "closed"
  if (props.hasActions) return "perm"
  if (props.status === "waiting") {
    if (props.activity && /ade-msg\s+ask|attende/i.test(props.activity)) return "ask"
    return "perm"
  }
  if (props.status === "working" || props.status === "provisioning") {
    if (props.activity && /ade-msg\s+ask|attende/i.test(props.activity)) return "ask"
    return "work"
  }
  if (props.quota && !("unavailable" in props.quota) && props.quota.isLimit) return "limit"
  return "idle"
}

/**
 * The state of a session as the sidebar knows it: no quota and no pane actions
 * there, so a waiting session is a permission (or a question to another
 * session, by its activity), a suspended one is `off`, and a finished one is
 * `closed`. `done` is only written when the process ends, or when a saved
 * session is restored without one, so in the sidebar «done» always means
 * «exited»: the pane passes `exited` from the live process, and without this
 * the two disagreed (the pane said «Chiusa», the row «Pronta» in green).
 * A usage limit is the one fact the pane has and the sidebar has not (the
 * quota is the pane's).
 */
export function stateOfSession(session: { status: PaneStatus; activity?: string; suspended?: boolean }): PaneState {
  return resolvePaneState({
    status: session.status,
    activity: session.activity,
    exited: session.status === "done",
    state: session.suspended ? "off" : undefined,
  })
}

/*
 * Spinner glyphs an agent draws in front of its status line (Claude's
 * asterisks, the braille dots of the others, the bullet and the half moons).
 */
const SPINNER_GLYPHS = /[✢-❋⏺●◐-◓⠀-⣿·]/g

/**
 * The detail a terminal scraper put in the chip, made readable: spinner glyphs
 * gone, a line repeated once per frame (`Mustering…Mustering…`) kept once, and
 * the half-drawn last frame (`3Musterin`) dropped. Empty when nothing real
 * is left, so the caller falls back to the state's own word.
 */
export function cleanStateDetail(raw: string | undefined): string {
  if (!raw) return ""
  const pieces = raw
    .replace(SPINNER_GLYPHS, " ")
    // An asterisk is a spinner frame only at the start; in `src/*.ts` it is part of the text.
    .replace(/^\s*\*+/, "")
    .split(/(?<=…|\.\.\.)|\n+/)
    .map((piece) => piece.replace(/\s+/g, " ").trim())
    .filter(Boolean)
  const kept: string[] = []
  for (const piece of pieces) {
    // Progress counters drawn beside the word («3», «12s», «1m») are not the word.
    const bare = piece.replace(/^[\d\s:.,]+(?:[smh]\b)?/, "").trim()
    if (!bare) continue
    if (kept.some((one) => one === bare || one.startsWith(bare))) continue
    kept.push(bare)
  }
  return kept.join(" ")
}

/** Activity codes that only restate the state's word: «Pronta · Disponibile» says it twice. */
const RESTATES_STATE = new Set(["ready", "running", "permission", "starting", "suspended"])

/**
 * What the chip says beside the state's word, from what the pane was told.
 *
 * `activity` is the agent's own report, free text of up to 40 characters, and
 * it is a spinner frame at times («Mustering…Mustering…✻Mustering…3Musterin»):
 * it is cleaned here, for every state, not only for the one that has fixed
 * words. A code that only restates the state gives nothing. Pure, so the
 * screenshot's string can be tested without a render.
 */
export function chipDetail(input: { stateDetail?: string; activity?: string }): string {
  if (input.stateDetail) return cleanStateDetail(input.stateDetail)
  if (input.activity === undefined) return ""
  if (RESTATES_STATE.has(normalizeActivity(input.activity))) return ""
  return cleanStateDetail(activityLabel(input.activity))
}

/**
 * The activity a pane is shown: what the agent says it is doing beats the
 * label ADE guessed, but only while it works. Its last report is never
 * cleared, so once the turn ends it would stay on the chip as a stale spinner
 * frame («Pronta · Mustering…», «Chiusa · Mustering…»). A suspended session is
 * doing nothing.
 */
export function paneActivity(
  pane: { suspended?: boolean; status: PaneStatus; activity?: string },
  reported: string | undefined,
): string | undefined {
  if (pane.suspended) return "suspended"
  return pane.status === "working" ? (reported ?? pane.activity) : pane.activity
}
