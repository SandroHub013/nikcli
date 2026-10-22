/**
 * How to install each agent of `agents.ts` that is not on this machine.
 *
 * The new-session form shows an agent that is not installed and, since this file, lets the user install it from
 * its card: the panel shows the command, the project's page, and runs the command in a terminal pane the user can
 * see. Nothing here runs anything; it is a table and the few rules that read it.
 *
 * Every command was copied from the project's own documentation or README, on the date in `checked`, and `source`
 * says which page. No blog, no third-party package. Where the project's page gives no command a user can run in one
 * line, or its command installs a program ADE does not start, the entry has no command and the panel offers the page
 * alone — a button that installs the wrong thing is worse than no button.
 *
 * What a command is run in is the pane's shell: `cmd` on Windows, the login shell elsewhere (`systemShell` in
 * `agents.ts`). A PowerShell command is therefore wrapped by `terminalLine`; the panel still shows the project's own
 * line, which is what the user would copy into PowerShell.
 */
import { AGENTS } from "./agents"
import type { Probe } from "./availability"

export type InstallOs = "windows" | "macos" | "linux"

/** A program a command needs and the machine may lack. Looked up by the host (`INSTALL_PREREQUISITES` in `pty.rs`). */
export type Prerequisite = "npm" | "winget" | "brew"

/** What a command is written for. `sh` is the pane's shell on macOS and Linux. */
export type InstallShell = "powershell" | "cmd" | "sh"

export interface InstallCommand {
  /** The line, as the project writes it (or, where `adapted` is set, as closely as the pane can run it). */
  line: string
  shell: InstallShell
  /** The program the line runs that may be missing; the panel says so and links to where it comes from. */
  requires?: Prerequisite
  /** The line differs from the project's own in a way that matters; the panel says which. */
  adapted?: "goose-temp"
}

/** A fact about the install the user should read before pressing the button. */
export type InstallCaveat =
  /** The project's installer provides `provides`, and ADE starts a different name: the card would stay absent. */
  | { kind: "binary"; provides: string }
  | { kind: "subscription" }
  | { kind: "wsl" }

export interface InstallEntry {
  /** An id of `AGENTS`. */
  agentId: string
  commands: Partial<Record<InstallOs, InstallCommand>>
  /** The project's page: always offered, and the only thing offered when there is no command. */
  page: string
  /** The page the commands were read from. */
  source: string
  /** `YYYY-MM-DD`, the day `source` was read. */
  checked: string
  caveat?: InstallCaveat
}

export const PREREQUISITES: Readonly<Record<Prerequisite, { page: string }>> = {
  npm: { page: "https://nodejs.org/en/download" },
  winget: { page: "https://learn.microsoft.com/windows/package-manager/winget/" },
  brew: { page: "https://brew.sh" },
}

const CHECKED = "2026-10-22"

const ps = (line: string, requires?: Prerequisite): InstallCommand => ({
  line,
  shell: "powershell",
  ...(requires ? { requires } : {}),
})
const cmd = (line: string): InstallCommand => ({ line, shell: "cmd" })
const sh = (line: string, requires?: Prerequisite): InstallCommand => ({
  line,
  shell: "sh",
  ...(requires ? { requires } : {}),
})
const npm = (line: string): InstallCommand => ({ line, shell: "cmd", requires: "npm" })
const everywhere = (command: InstallCommand): Partial<Record<InstallOs, InstallCommand>> => ({
  windows: command,
  // `npm` is the same program in every shell; the `shell` of its line is the pane's.
  macos: { ...command, shell: "sh" },
  linux: { ...command, shell: "sh" },
})

/**
 * One entry per agent, in the order of `AGENTS`. The terminal is not an agent and has none.
 */
export const INSTALLS: readonly InstallEntry[] = [
  {
    agentId: "claude-code",
    commands: {
      windows: ps("irm https://claude.ai/install.ps1 | iex"),
      macos: sh("curl -fsSL https://claude.ai/install.sh | bash"),
      linux: sh("curl -fsSL https://claude.ai/install.sh | bash"),
    },
    page: "https://code.claude.com/docs/en/setup",
    source: "https://code.claude.com/docs/en/setup",
    checked: CHECKED,
  },
  {
    agentId: "codex",
    commands: {
      // The project's own line, which starts PowerShell itself: it runs as it is in cmd.
      windows: cmd('powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"'),
      macos: sh("curl -fsSL https://chatgpt.com/codex/install.sh | sh"),
      linux: sh("curl -fsSL https://chatgpt.com/codex/install.sh | sh"),
    },
    page: "https://github.com/openai/codex",
    source: "https://github.com/openai/codex",
    checked: CHECKED,
  },
  {
    agentId: "opencode",
    commands: {
      windows: npm("npm install -g opencode-ai"),
      macos: sh("curl -fsSL https://opencode.ai/install | bash"),
      linux: sh("curl -fsSL https://opencode.ai/install | bash"),
    },
    page: "https://opencode.ai/docs/",
    source: "https://opencode.ai/docs/",
    checked: CHECKED,
    caveat: { kind: "wsl" },
  },
  {
    // ADE's own fork: its installer is a script in the repository, not a published address a user can run.
    agentId: "ragu",
    commands: {},
    page: "https://github.com/SandroHub013/nikcli",
    source: "https://github.com/SandroHub013/nikcli#installation",
    checked: CHECKED,
  },
  {
    agentId: "grok",
    commands: {
      windows: ps("irm https://x.ai/cli/install.ps1 | iex"),
      macos: sh("curl -fsSL https://x.ai/cli/install.sh | bash"),
      linux: sh("curl -fsSL https://x.ai/cli/install.sh | bash"),
    },
    page: "https://docs.x.ai/build/overview",
    source: "https://docs.x.ai/build/overview",
    checked: CHECKED,
  },
  {
    agentId: "agy",
    commands: {
      // The PowerShell line, not the CMD one: that one downloads `install.cmd` into the folder the pane is in.
      windows: ps("irm https://antigravity.google/cli/install.ps1 | iex"),
      macos: sh("curl -fsSL https://antigravity.google/cli/install.sh | bash"),
      linux: sh("curl -fsSL https://antigravity.google/cli/install.sh | bash"),
    },
    page: "https://antigravity.google/docs/getting-started?tab=cli",
    source: "https://antigravity.google/docs/getting-started?tab=cli",
    checked: CHECKED,
  },
  {
    agentId: "kimi",
    commands: {
      windows: ps("irm https://code.kimi.com/kimi-code/install.ps1 | iex"),
      macos: sh("curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash"),
      linux: sh("curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash"),
    },
    page: "https://github.com/MoonshotAI/kimi-cli",
    source: "https://github.com/MoonshotAI/kimi-cli",
    checked: CHECKED,
  },
  {
    // The README installs `prime-agent`; ADE starts `prime`.
    agentId: "prime",
    commands: {},
    page: "https://github.com/PrimeIntellect-ai/prime-agent",
    source: "https://github.com/PrimeIntellect-ai/prime-agent",
    checked: CHECKED,
    caveat: { kind: "binary", provides: "prime-agent" },
  },
  {
    agentId: "pi",
    commands: {
      windows: cmd('powershell -c "irm https://pi.dev/install.ps1 | iex"'),
      macos: sh("curl -fsSL https://pi.dev/install.sh | sh"),
      linux: sh("curl -fsSL https://pi.dev/install.sh | sh"),
    },
    page: "https://github.com/badlogic/pi-mono",
    source: "https://github.com/badlogic/pi-mono",
    checked: CHECKED,
  },
  {
    // The README installs `omp`; ADE starts `ohmypi`.
    agentId: "ohmypi",
    commands: {},
    page: "https://github.com/can1357/oh-my-pi",
    source: "https://github.com/can1357/oh-my-pi",
    checked: CHECKED,
    caveat: { kind: "binary", provides: "omp" },
  },
  {
    agentId: "hermes",
    commands: {
      windows: ps("iex (irm https://hermes-agent.nousresearch.com/install.ps1)"),
      macos: sh("curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash"),
      linux: sh("curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash"),
    },
    page: "https://github.com/NousResearch/hermes-agent",
    source: "https://github.com/NousResearch/hermes-agent",
    checked: CHECKED,
  },
  {
    agentId: "freebuff",
    commands: everywhere(npm("npm install -g freebuff")),
    page: "https://freebuff.com/cli",
    source: "https://freebuff.com/cli",
    checked: CHECKED,
  },
  {
    agentId: "cline",
    commands: everywhere(npm("npm i -g cline")),
    page: "https://github.com/cline/cline",
    source: "https://github.com/cline/cline",
    checked: CHECKED,
  },
  {
    agentId: "crush",
    commands: {
      windows: { line: "winget install charmbracelet.crush", shell: "cmd", requires: "winget" },
      macos: sh("brew install charmbracelet/tap/crush", "brew"),
      linux: { line: "npm install -g @charmland/crush", shell: "sh", requires: "npm" },
    },
    page: "https://github.com/charmbracelet/crush",
    source: "https://github.com/charmbracelet/crush",
    checked: CHECKED,
  },
  {
    agentId: "kilo",
    commands: everywhere(npm("npm install -g @kilocode/cli")),
    page: "https://kilo.ai/docs/code-with-ai/platforms/cli",
    source: "https://kilo.ai/docs/code-with-ai/platforms/cli",
    checked: CHECKED,
  },
  {
    agentId: "goose",
    commands: {
      /*
       * The project's two steps are `Invoke-WebRequest … -OutFile download_cli.ps1` and `.\download_cli.ps1`, which
       * leave the script in the project folder the pane opens in. The same two steps, the file in %TEMP% and run with
       * the policy bypassed for this one script — a restricted policy refuses the project's `.\download_cli.ps1`.
       */
      windows: {
        line: "powershell -NoProfile -ExecutionPolicy Bypass -Command \"$f = Join-Path $env:TEMP 'download_cli.ps1'; Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/aaif-goose/goose/main/download_cli.ps1' -OutFile $f; & $f\"",
        shell: "cmd",
        adapted: "goose-temp",
      },
      macos: sh("curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash"),
      linux: sh("curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash"),
    },
    page: "https://goose-docs.ai/docs/getting-started/installation",
    source: "https://goose-docs.ai/docs/getting-started/installation",
    checked: CHECKED,
  },
  {
    agentId: "copilot",
    commands: {
      windows: { line: "winget install GitHub.Copilot", shell: "cmd", requires: "winget" },
      macos: sh("curl -fsSL https://gh.io/copilot-install | bash"),
      linux: sh("curl -fsSL https://gh.io/copilot-install | bash"),
    },
    page: "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
    source: "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
    checked: CHECKED,
    caveat: { kind: "subscription" },
  },
  {
    agentId: "cursor",
    commands: {
      windows: ps("irm 'https://cursor.com/install?win32=true' | iex"),
      macos: sh("curl https://cursor.com/install -fsS | bash"),
      linux: sh("curl https://cursor.com/install -fsS | bash"),
    },
    page: "https://cursor.com/docs/cli/overview",
    source: "https://cursor.com/docs/cli/overview",
    checked: CHECKED,
  },
  {
    agentId: "t3",
    commands: {
      windows: ps("irm https://t3.codes/install.ps1 | iex"),
      macos: sh("curl -fsSL https://t3.codes/install.sh | sh"),
      linux: sh("curl -fsSL https://t3.codes/install.sh | sh"),
    },
    page: "https://t3.codes/",
    source: "https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md",
    checked: CHECKED,
  },
]

/** The entry for an agent, or undefined for one with nothing to install (the terminal). */
export function installFor(agentId: string): InstallEntry | undefined {
  return INSTALLS.find((entry) => entry.agentId === agentId)
}

/**
 * The system this is running on, for choosing a command. Read from the user agent like `systemShell`, so the two
 * agree on which shell the pane is.
 */
export function installOs(userAgent: string = typeof navigator !== "undefined" ? (navigator.userAgent ?? "") : ""): InstallOs {
  if (/win/i.test(userAgent)) return "windows"
  if (/mac/i.test(userAgent)) return "macos"
  return "linux"
}

/** The command for this system, or undefined when the project gives none (only its page is offered). */
export function commandFor(entry: InstallEntry | undefined, os: InstallOs): InstallCommand | undefined {
  return entry?.commands[os]
}

/**
 * What is typed into the terminal pane for `command`.
 *
 * The pane is `cmd` on Windows, so a line written for PowerShell is handed to it: `powershell -NoProfile -Command
 * "<line>"`. Nothing else changes and nothing is hidden — the pane shows the line as typed, and the user sees its
 * output. A PowerShell line may not hold a double quote, which is what would end the wrapper early (a test checks).
 */
export function terminalLine(command: InstallCommand): string {
  if (command.shell !== "powershell") return command.line
  return `powershell -NoProfile -Command "${command.line}"`
}

/** Agents in the install table that are not in the catalogue, and catalogue agents with no entry; both should be none. */
export function installGaps(): { unknown: string[]; missing: string[] } {
  const known = new Set(AGENTS.map((agent) => agent.id))
  const covered = new Set(INSTALLS.map((entry) => entry.agentId))
  return {
    unknown: INSTALLS.filter((entry) => !known.has(entry.agentId)).map((entry) => entry.agentId),
    missing: AGENTS.filter((agent) => agent.id !== "terminal" && !covered.has(agent.id)).map((agent) => agent.id),
  }
}

/**
 * The program `command` needs that this machine lacks, or undefined: present, nothing needed, or no way to look.
 * With no probe nothing is claimed missing, for the reason `detectAgents` gives.
 */
export async function missingPrerequisite(
  command: InstallCommand | undefined,
  probe: Probe | undefined,
): Promise<Prerequisite | undefined> {
  if (!command?.requires || !probe) return undefined
  const found = await probe(command.requires, "--version").catch(() => null)
  return found === null ? command.requires : undefined
}
