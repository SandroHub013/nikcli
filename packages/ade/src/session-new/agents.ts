/**
 * The agents ADE can start, and how to start them.
 *
 * `command` is what gets executed, so this file is the single place that knows
 * an agent's CLI name. Whether it is installed is answered by looking that name
 * up on PATH rather than by trusting a hardcoded list that rots the moment the
 * user installs or removes one.
 *
 * There is deliberately no per-agent "how to run one task non-interactively"
 * any more. Every one of these is started bare, in a real terminal, exactly as
 * the user would start it themselves — which is the point: what happens next is
 * theirs to decide, not ADE's to script. A session that opens with a task types
 * that task in as the first thing the user would have typed, and one that opens
 * without simply waits, the way a terminal waits.
 */

export interface AgentOption {
  id: string
  label: string
  /** Executable name, resolved on PATH. */
  command: string
}

/*
 * No `glyph` here any more.
 *
 * Every entry used to carry one character — ✳ ◎ ✦ ◧ ◆ ◉ — described in its own
 * doc comment as a stand-in "until real icons are wired". They are wired now,
 * in `agent-mark.tsx`, and a placeholder left in the catalogue is a second
 * answer to "what does this agent look like" that nothing keeps in step with
 * the first.
 */
export const AGENTS: AgentOption[] = [
  { id: "claude-code", label: "Claude Code", command: "claude" },
  { id: "codex", label: "Codex", command: "codex" },
  { id: "opencode", label: "OpenCode", command: "opencode" },
  { id: "nikcli", label: "nikcli", command: "nikcli" },
  { id: "agy", label: "agy", command: "agy" },
  { id: "kimi", label: "Kimi Code", command: "kimi" },
  { id: "prime", label: "Prime Agent", command: "prime" },
  { id: "pi", label: "pi", command: "pi" },
  { id: "ohmypi", label: "OhMyPi", command: "ohmypi" },
  { id: "hermes", label: "Hermes", command: "hermes" },
  {
    id: "terminal",
    label: "Terminal",
    // Not an agent: the shell a workbench preset drops into its second slot.
    command: systemShell(),
  },
]

/**
 * The shell this machine has, named the way PATH will find it.
 *
 * `terminal` used to carry an empty command while staying selectable in the
 * new-session form, and `startProcess` begins with `if (!agent.command) return`
 * — so choosing Terminal and pressing Avvia created a pane that sat at
 * "Inizializzazione" forever, with no error anywhere. A pane that never starts
 * is worse than one that fails.
 *
 * A constant rather than a probe: the one program every machine has is a
 * shell, and only its name differs. Kept in step with ALLOWED_SHELLS in
 * `src-tauri/src/pty.rs`, which decides what may actually be started.
 */
export function systemShell(): string {
  const isWindows =
    typeof navigator !== "undefined" && /win/i.test(navigator.userAgent ?? "")
  return isWindows ? "cmd" : "sh"
}

export function agentById(id: string): AgentOption | undefined {
  return AGENTS.find((agent) => agent.id === id)
}

export function agentLabel(id: string): string {
  return agentById(id)?.label ?? id
}

export interface AgentBrand {
  color: string
  tint: string
  border: string
  contrast?: string
  vendor: string
}

export const AGENT_BRANDS: Record<string, AgentBrand> = {
  "claude-code": {
    color: "#d97757",
    tint: "rgba(217, 119, 87, 0.14)",
    border: "rgba(217, 119, 87, 0.35)",
    vendor: "Anthropic",
  },
  codex: {
    color: "#10a37f",
    tint: "rgba(16, 163, 127, 0.14)",
    border: "rgba(16, 163, 127, 0.35)",
    vendor: "OpenAI",
  },
  opencode: {
    color: "#f1ecec",
    tint: "rgba(241, 236, 236, 0.12)",
    border: "rgba(241, 236, 236, 0.30)",
    contrast: "#121212",
    vendor: "Anomaly",
  },
  nikcli: {
    color: "#3b82f6",
    tint: "rgba(59, 130, 246, 0.15)",
    border: "rgba(59, 130, 246, 0.40)",
    vendor: "nikcli",
  },
  agy: {
    color: "#a855f7",
    tint: "rgba(168, 85, 247, 0.14)",
    border: "rgba(168, 85, 247, 0.35)",
    vendor: "Google",
  },
  kimi: {
    color: "#1783ff",
    tint: "rgba(23, 131, 255, 0.14)",
    border: "rgba(23, 131, 255, 0.35)",
    vendor: "Moonshot",
  },
  prime: {
    color: "#6366f1",
    tint: "rgba(99, 102, 241, 0.14)",
    border: "rgba(99, 102, 241, 0.35)",
    vendor: "Prime Intellect",
  },
  pi: {
    color: "#f59e0b",
    tint: "rgba(245, 158, 11, 0.14)",
    border: "rgba(245, 158, 11, 0.35)",
    vendor: "pi.dev",
  },
  ohmypi: {
    color: "#f97316",
    tint: "rgba(249, 115, 22, 0.14)",
    border: "rgba(249, 115, 22, 0.35)",
    vendor: "OhMyPi",
  },
  hermes: {
    color: "#ef4444",
    tint: "rgba(239, 68, 68, 0.14)",
    border: "rgba(239, 68, 68, 0.35)",
    vendor: "Nous Research",
  },
  terminal: {
    color: "#22c55e",
    tint: "rgba(34, 197, 94, 0.14)",
    border: "rgba(34, 197, 94, 0.35)",
    vendor: "System",
  },
}

export function agentBrand(id: string): AgentBrand {
  return (
    AGENT_BRANDS[id] ?? {
      color: "var(--ade-accent)",
      tint: "var(--ade-accent-soft)",
      border: "var(--ade-border)",
      vendor: "Agent",
    }
  )
}
