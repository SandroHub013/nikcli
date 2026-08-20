/**
 * The agents ADE can start, and how to start them.
 *
 * `command` is what gets executed, so this file is the single place that knows
 * an agent's CLI name. `probe` is the argument that makes the CLI print its
 * version and exit — running that is how ADE decides whether an agent is
 * installed, rather than trusting a hardcoded list that rots the moment the
 * user installs or removes one.
 *
 * `promptArgs` builds a non-interactive run for a given task. Agents differ
 * here and the differences are not cosmetic: getting them wrong means a session
 * that hangs waiting for input nobody will type.
 */

export interface AgentOption {
  id: string
  label: string
  /** Single glyph stand-in for the product mark, until real icons are wired. */
  glyph: string
  /** Executable name, resolved on PATH. */
  command: string
  /** Argument that prints a version and exits; used to detect installation. */
  probe: string
  /** Arguments for a one-shot run of `task`; empty means start interactively. */
  promptArgs?: (task: string) => string[]
}

export const AGENTS: AgentOption[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    glyph: "✳",
    command: "claude",
    probe: "--version",
    promptArgs: (task) => ["-p", task],
  },
  {
    id: "codex",
    label: "Codex",
    glyph: "◎",
    command: "codex",
    probe: "--version",
    promptArgs: (task) => ["exec", task],
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    glyph: "✦",
    command: "gemini",
    probe: "--version",
    promptArgs: (task) => ["-p", task],
  },
  {
    id: "opencode",
    label: "OpenCode",
    glyph: "◧",
    command: "opencode",
    probe: "--version",
    promptArgs: (task) => ["run", task],
  },
  {
    id: "nikcli",
    label: "nikcli",
    glyph: "N",
    command: "nikcli",
    probe: "--version",
    // `nikcli run <message>` is the non-interactive form; the bare command
    // starts the TUI and would sit waiting for input nobody types.
    promptArgs: (task) => ["run", task],
  },
  {
    id: "agy",
    label: "agy",
    glyph: "◆",
    command: "agy",
    probe: "--version",
    // agy blocks on permission prompts in one-shot mode, which is exactly the
    // hang this field exists to avoid.
    promptArgs: (task) => ["-p", task, "--dangerously-skip-permissions"],
  },
  {
    id: "kimi",
    label: "Kimi",
    glyph: "†",
    command: "kimi",
    probe: "--version",
    // kimi rejects --prompt combined with any auto-approve flag, and exits 0
    // while doing it, so the flag must not be added here.
    promptArgs: (task) => ["-p", task],
  },
  {
    id: "terminal",
    label: "Terminal",
    glyph: "▭",
    // Not an agent: the shell a workbench preset drops into its second slot.
    command: "",
    probe: "",
  },
]

export function agentById(id: string): AgentOption | undefined {
  return AGENTS.find((agent) => agent.id === id)
}

export function agentLabel(id: string): string {
  return agentById(id)?.label ?? id
}

export function agentGlyph(id: string): string {
  return agentById(id)?.glyph ?? "•"
}
