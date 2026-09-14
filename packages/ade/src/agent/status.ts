/**
 * How the agent console describes what the assistant is doing right now.
 *
 * Extracted from the component because the interesting part is the mapping,
 * not the markup, and a `.tsx` cannot be imported under `bun test` in this
 * repo. Both the component and the test read this file; neither copies it.
 */

/** Mirrors `DialogStatus` in `@nikcli-ai/voice`, plus the engine being off. */
export type AgentPresence = "off" | "asleep" | "idle" | "listening" | "confirming" | "dictating" | "executing"

export interface PresenceLabel {
  /** Short phrase for the status pill. */
  text: string
  /**
   * Which status colour to wear.
   *
   * Reuses the pane status ramp rather than inventing one: a user who has
   * learnt that amber means "working" in the grid should not have to learn a
   * second vocabulary one section to the left.
   */
  tone: "idle" | "working" | "waiting" | "done" | "error"
}

const LABELS: Record<AgentPresence, PresenceLabel> = {
  off: { text: "Microfono spento", tone: "idle" },
  asleep: { text: "In attesa della parola di richiamo", tone: "idle" },
  idle: { text: "In ascolto", tone: "done" },
  listening: { text: "Ti sto ascoltando", tone: "done" },
  confirming: { text: "Aspetto una conferma", tone: "waiting" },
  dictating: { text: "Dettatura in corso", tone: "waiting" },
  executing: { text: "Sto eseguendo", tone: "working" },
}

export function presenceLabel(presence: AgentPresence): PresenceLabel {
  return LABELS[presence]
}

/**
 * The engine's two facts — running, and what the dialogue is doing — folded
 * into the one thing the console shows.
 *
 * `running` wins: a dialogue state left over from the last session says
 * "listening" at a microphone that is closed, and that is the single most
 * misleading thing this panel could claim.
 */
export function presenceOf(input: { running: boolean; status: string }): AgentPresence {
  if (!input.running) return "off"
  return (input.status in LABELS ? input.status : "idle") as AgentPresence
}
