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
  /**
   * Arguments every start of this CLI needs, before any of ADE's own.
   *
   * Cline is the case: bare, with a task, it runs the task headless in act
   * mode with every step approved; its terminal interface is `--tui` (`cline
   * --help`, the CLI reference). A pane is the interface, so it asks for it.
   */
  args?: readonly string[]
  /**
   * `app`: not an agent but a program with a web interface of its own, run in
   * the pane as a server. No task is typed into it, and it is not something an
   * agent can be asked to spawn. T3 Code is the case: `t3` starts its server
   * and opens its app in the system browser, and that app drives the agents
   * listed above; when the server prints its local address, ADE offers to open
   * it in a web pane too (`browser/dev-server.ts`).
   */
  kind?: "app"
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
  { id: "grok", label: "Grok", command: "grok" },
  { id: "agy", label: "agy", command: "agy" },
  { id: "kimi", label: "Kimi Code", command: "kimi" },
  { id: "prime", label: "Prime Agent", command: "prime" },
  { id: "pi", label: "pi", command: "pi" },
  { id: "ohmypi", label: "OhMyPi", command: "ohmypi" },
  { id: "hermes", label: "Hermes", command: "hermes" },
  /*
   * From `ade-team/results/agenti-mancanti.md` (2026-09-27). Each is looked up
   * on PATH like the rest, so one that is not installed shows as absent.
   */
  { id: "freebuff", label: "Freebuff", command: "freebuff" },
  { id: "cline", label: "Cline", command: "cline", args: ["--tui"] },
  { id: "crush", label: "Crush", command: "crush" },
  { id: "kilo", label: "Kilo", command: "kilo" },
  { id: "goose", label: "goose", command: "goose" },
  { id: "copilot", label: "Copilot", command: "copilot" },
  /*
   * Cursor's CLI calls itself `agent`, and that name is not Cursor's alone:
   * here it is also Grok Build's alias, found first on PATH. The installer
   * puts `cursor-agent` beside it (`%LOCALAPPDATA%\cursor-agent`), a name
   * nothing else claims.
   */
  { id: "cursor", label: "Cursor", command: "cursor-agent" },
  { id: "t3", label: "T3 Code", command: "t3", kind: "app" },
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
  const agent = typeof navigator !== "undefined" ? (navigator.userAgent ?? "") : ""
  if (/win/i.test(agent)) return "cmd"
  // macOS has shipped zsh as the login shell since Catalina; its `sh` is a
  // bash 3.2 that reads none of the user's profile, so the prompt came up as
  // `sh-3.2$` without the PATH anything in the terminal is installed on.
  if (/mac/i.test(agent)) return "zsh"
  return "sh"
}

export function agentById(id: string): AgentOption | undefined {
  return AGENTS.find((agent) => agent.id === id)
}

/** Whether this is an app run as a server (`kind: "app"`) rather than an agent a task is typed into. */
export function isApp(id: string): boolean {
  return agentById(id)?.kind === "app"
}

export function agentLabel(id: string): string {
  return agentById(id)?.label ?? id
}

/*
 * No brand colours here either.
 *
 * There was an `AGENT_BRANDS` table — colour, tint, border per agent — that
 * the launcher wrote into each tile as inline `--cli-*` variables. The same
 * variables are declared per `[data-agent-id]` in `session-new.css`, with
 * light and dark values and a glow the table never had; the inline copy won
 * on specificity and quietly overrode the file that looked authoritative.
 * Two tables of the same colours drift, and these had: the CSS said one teal
 * for Codex and the table another. The stylesheet is now the one place, next
 * to the rules that use the values, and `agent-mark.tsx` says which colours
 * are actually the vendors'.
 */
