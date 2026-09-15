import type { SessionQuotaView } from "../session/quota"

/*
 * `provisioning` comes before `working`: the worktree checkout runs for seconds
 * before the process starts, and a card stuck on `waiting` there reads as
 * "needs an answer" — which this session is not asking for.
 */
export type PaneStatus = "idle" | "provisioning" | "working" | "waiting" | "done" | "error"

/** The 6 distinct canonical session states for Proposal A header. */
export type PaneState = "work" | "perm" | "ask" | "err" | "limit" | "idle"

export const STATE_FULL: Record<PaneState, string> = {
  work: "Al lavoro",
  perm: "In attesa di permesso",
  ask: "Attende un'altra sessione",
  err: "Bloccata",
  limit: "Limite raggiunto",
  idle: "Pronta",
}

export const STATE_SHORT: Record<PaneState, string> = {
  work: "Al lavoro",
  perm: "Permesso",
  ask: "Attende",
  err: "Bloccata",
  limit: "Limite",
  idle: "Pronta",
}

/**
 * Maps incoming status, activity, quota, and pending actions into one of the 6 canonical states:
 * - work: active agent task (working, provisioning)
 * - perm: waiting for user permission or interactive prompt action
 * - ask: waiting on another session (e.g. ade-msg ask)
 * - err: agent process failed or exited with error
 * - limit: provider quota rate limited or exhausted
 * - idle: prompt ready, agent waiting for instruction
 */
export function resolvePaneState(props: {
  status?: PaneStatus
  state?: PaneState
  activity?: string
  quota?: SessionQuotaView
  hasActions?: boolean
}): PaneState {
  if (props.state) return props.state
  if (props.status === "error") return "err"
  if (props.quota?.isLimit) return "limit"
  if (props.hasActions) return "perm"
  if (props.status === "waiting") {
    if (props.activity && /ask|attende/i.test(props.activity)) return "ask"
    return "perm"
  }
  if (props.status === "working" || props.status === "provisioning") {
    if (props.activity && /ade-msg\s+ask|attende/i.test(props.activity)) return "ask"
    return "work"
  }
  return "idle"
}
