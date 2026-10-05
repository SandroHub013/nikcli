import { Flag } from "@nikcli-ai/util/flag"
import { lazy } from "@nikcli-ai/util/lazy"
import path from "path"
import { spawn, type ChildProcess } from "child_process"

const SIGKILL_TIMEOUT_MS = 200

export namespace Shell {
  /**
   * Approved PowerShell verbs, the first half of a `Verb-Noun` cmdlet.
   *
   * Matched case-sensitively on purpose: PowerShell is case-insensitive but always writes verbs
   * capitalized, and a case-insensitive match reads English prose inside a quoted program as a
   * cmdlet — `# out-of-order` and `d.remove-item` in an embedded Python file are enough to send a
   * whole bash line to PowerShell.
   */
  const POWERSHELL_VERBS = [
    "Add",
    "Assert",
    "Backup",
    "Block",
    "Clear",
    "Compare",
    "Compress",
    "Complete",
    "Confirm",
    "Convert",
    "ConvertFrom",
    "ConvertTo",
    "Copy",
    "Deny",
    "Disable",
    "Enter",
    "Exit",
    "Expand",
    "Export",
    "ForEach",
    "Format",
    "Get",
    "Grant",
    "Group",
    "Hash",
    "Import",
    "Initialize",
    "Install",
    "Invoke",
    "Join",
    "Lock",
    "Measure",
    "Move",
    "New",
    "Out",
    "Protect",
    "Publish",
    "Push",
    "Read",
    "Register",
    "Remove",
    "Rename",
    "Request",
    "Reset",
    "Resolve",
    "Restart",
    "Resume",
    "Revoke",
    "Save",
    "Search",
    "Select",
    "Set",
    "Show",
    "Sort",
    "Split",
    "Start",
    "Step",
    "Stop",
    "Sync",
    "Test",
    "Trace",
    "Unblock",
    "Unlock",
    "Unprotect",
    "Unregister",
    "Update",
    "Use",
    "Wait",
    "Watch",
    "Where",
    "Write",
  ].join("|")

  /**
   * Where a command may start: the beginning of the line, after a statement or pipe separator, or
   * inside a block. Requiring this is what keeps a `Verb-Noun` inside a quoted program from being
   * mistaken for a cmdlet call.
   */
  const COMMAND_POSITION = "(?:^|[\\n;&|({=]|\\b(?:then|do|else)\\b)[ \\t]*"

  /**
   * Constructs PowerShell cannot parse and does not otherwise have, so their presence alone settles
   * the dialect. Everything bash-shaped but shareable — `$(…)`, the backtick, `VAR=val cmd`,
   * `[ … ]`, `&&` with a POSIX utility — is deliberately absent: PowerShell spells all of those
   * too, and a real user writing `"count: $($items.Count)"` must not lose it to a marker.
   */
  const BASH_MARKERS: RegExp[] = [
    // heredoc: `<<TAG` / `<<'TAG'` / `<<-TAG`, with the tag ending the line, unlike a `<<` shift
    /<<-?[ \t]*(['"]?)[A-Za-z_]\w*\1[ \t]*$/m,
    // `for x in y; do …; done`
    /\b(?:for|while|until)\b[^;]*;[ \t]*do\b[\s\S]*\bdone\b/,
    // `if …; then …; fi`
    /\bif\b[^;]*;[ \t]*then\b[\s\S]*\bfi\b/,
    // POSIX-only device names
    /\/dev\/(?:null|stdout|stderr|stdin|tty|fd|zero|random|urandom)\b/,
  ]

  /** Constructs only PowerShell spells this way. */
  const POWERSHELL_MARKERS: RegExp[] = [
    /\$env:/i,
    /\$(?:LASTEXITCODE|PSVersionTable|PSScriptRoot|PSHome|PSEdition|ErrorActionPreference)\b/,
    // assignment to a variable; bash assigns to a bare `NAME`, never a `$name`. The name cannot
    // start with a digit, or `awk '{$1=""; print}'` reads as a PowerShell assignment
    /\$[A-Za-z_]\w*[ \t]*=(?!=)/,
    // discarding output; bash has no `$null`
    /\*>[ \t]*\$null|\d?>+[ \t]*\$null/,
    // common parameters, which no POSIX program spells this way
    /-(?:ErrorAction|ErrorVariable|WarningAction|InformationAction|WhatIf|Confirm)\b/,
    new RegExp(`${COMMAND_POSITION}(?:${POWERSHELL_VERBS})-[A-Za-z]+`),
  ]

  /**
   * The dialect {@link select} routes this command to.
   *
   * A model writing a shell command writes one dialect or the other, never a mix, so a single
   * construct the other language cannot even parse settles it. Bash wins that round, because bash is
   * the dialect the tool is documented in: sending a `for … done` to PowerShell only trades a
   * working line for a parse error. Past that first round, PowerShell markers decide.
   *
   * With neither marker the answer is bash, and that default is also what makes the shared
   * constructs — `$(…)`, the backtick, `VAR=val cmd`, `[ … ]`, `&&` with a POSIX utility — need no
   * marker of their own: PowerShell spells all of them too, so they are only ever evidence once
   * nothing has said PowerShell, which is the same place this returns anyway.
   */
  export function dialect(command: string): "powershell" | "bash" {
    if (BASH_MARKERS.some((marker) => marker.test(command))) return "bash"
    return POWERSHELL_MARKERS.some((marker) => marker.test(command)) ? "powershell" : "bash"
  }

  function hasPowerShellMarkers(command: string) {
    if (process.platform !== "win32") return false
    return dialect(command) === "powershell"
  }

  /**
   * Whether {@link select} would route this command to PowerShell.
   *
   * Permission analysis needs to know, because the Bash grammar mis-reads PowerShell syntax and
   * would derive the wrong set of commands to authorize.
   */
  export function isPowerShell(command: string) {
    return hasPowerShellMarkers(command)
  }

  function selectBinary(candidates: string[]) {
    for (const candidate of candidates) {
      const bin = Bun.which(candidate)
      if (bin) return bin
    }
  }

  function powershellBinary() {
    const configured = process.env["NIKCLI_POWERSHELL_PATH"]
    return selectBinary([configured, "pwsh", "powershell"].filter((name): name is string => Boolean(name)))
  }

  export async function killTree(proc: ChildProcess, opts?: { exited?: () => boolean }): Promise<void> {
    const pid = proc.pid
    if (!pid || opts?.exited?.()) return

    if (process.platform === "win32") {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/pid", String(pid), "/f", "/t"], { windowsHide: true, stdio: "ignore" })
        killer.once("exit", () => resolve())
        killer.once("error", () => resolve())
      })
      return
    }

    try {
      process.kill(-pid, "SIGTERM")
      await Bun.sleep(SIGKILL_TIMEOUT_MS)
      if (!opts?.exited?.()) {
        process.kill(-pid, "SIGKILL")
      }
    } catch {
      proc.kill("SIGTERM")
      await Bun.sleep(SIGKILL_TIMEOUT_MS)
      if (!opts?.exited?.()) {
        proc.kill("SIGKILL")
      }
    }
  }
  const BLACKLIST = new Set(["fish", "nu"])

  function fallback() {
    if (process.platform === "win32") {
      if (Flag.NIKCLI_GIT_BASH_PATH) return Flag.NIKCLI_GIT_BASH_PATH
      const git = Bun.which("git")
      if (git) {
        const bash = path.join(git, "..", "..", "bin", "bash.exe")
        if (Bun.file(bash).size) return bash
      }
      return process.env.COMSPEC || "cmd.exe"
    }
    if (process.platform === "darwin") return "/bin/zsh"
    const bash = Bun.which("bash")
    if (bash) return bash
    return "/bin/sh"
  }

  export function select(command?: string) {
    if (command && hasPowerShellMarkers(command)) {
      const binary = powershellBinary()
      if (binary) return binary
    }
    return acceptable()
  }

  export function isPowerShellBinary(binary: string) {
    const name = path
      .basename(binary)
      .toLowerCase()
      .replace(/\.exe$/, "")
    return name === "pwsh" || name === "powershell"
  }

  /**
   * Explicit argv for shells that need flags Node's `shell:` option cannot supply.
   *
   * PowerShell otherwise prints a startup banner into the captured output and stays interactive,
   * so a command that hits a confirmation prompt would hang until the tool's timeout instead of
   * failing. Returns `undefined` for shells that Node's own handling covers correctly.
   */
  export function directInvocation(binary: string, command: string): { file: string; args: string[] } | undefined {
    if (!isPowerShellBinary(binary)) return undefined
    return { file: binary, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] }
  }

  /**
   * Human-readable name of the shell commands will actually run under.
   *
   * Reported to the model so it writes commands in the right dialect instead of assuming the
   * platform default. Falls back to the raw path when the basename is not informative.
   */
  export function describe() {
    const binary = acceptable()
    const name = path
      .basename(binary)
      .toLowerCase()
      .replace(/\.exe$/, "")
    if (name === "pwsh" || name === "powershell") return "PowerShell"
    if (name === "cmd") return "cmd.exe"
    return name || binary
  }

  export const preferred = lazy(() => {
    const s = process.env.SHELL
    if (s) return s
    return fallback()
  })

  export const acceptable = lazy(() => {
    const s = process.env.SHELL
    if (s && !BLACKLIST.has(process.platform === "win32" ? path.win32.basename(s) : path.basename(s))) return s
    return fallback()
  })
}
