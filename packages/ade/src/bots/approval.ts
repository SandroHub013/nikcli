/**
 * Approvals in a bot's chat (B8c): the scheme of a «dangerous command
 * approval», written for ADE's runners.
 *
 * What a bot asks to run meets three things, in this order:
 * 1. a fixed block list: a command that wipes a disk, formats, reboots or
 *    deletes from the root is refused, whatever else says yes — the bot's
 *    «Sempre», a click, a phone, anything;
 * 2. a list of dangerous commands (recursive deletes, force pushes, a script
 *    piped into a shell, elevation, killing processes, …): the turn stops and
 *    the user is asked — Consenti (this once), Nega, or Sempre;
 * 3. anything else goes through.
 * A write outside the project (nikcli's `external_directory`) is always
 * asked. No answer within `APPROVAL_TIMEOUT_MS` is a Nega.
 *
 * «Sempre» is ADE's, per bot: it is kept here by bot and by kind of danger
 * (or by folder, for a write outside), never handed to nikcli as its own
 * «always», which nikcli keeps for the whole project and so for every bot.
 *
 * The lists are patterns on the command as written: a
 * heuristic that catches the usual forms, not a sandbox. The tools a turn is
 * given stay the boundary (`runners.ts`).
 */

import { t } from "../i18n"

type ReasonKey =
  | "bots.approval.reason.deleteRoot"
  | "bots.approval.reason.disk"
  | "bots.approval.reason.forkBomb"
  | "bots.approval.reason.power"
  | "bots.approval.reason.system"
  | "bots.approval.reason.recursiveDelete"
  | "bots.approval.reason.gitRewrite"
  | "bots.approval.reason.pipeToShell"
  | "bots.approval.reason.elevate"
  | "bots.approval.reason.killProcess"
  | "bots.approval.reason.permissions"
  | "bots.approval.reason.systemConfig"
  | "bots.approval.reason.shellStartup"
  | "bots.approval.reason.database"
  | "bots.approval.reason.publish"
  | "bots.approval.reason.containers"
  | "bots.approval.reason.nestedShell"
  | "bots.approval.reason.opaqueShell"
  | "bots.approval.reason.consoleWrite"

/** Five minutes, as the phone's question (`gateway/approval.ts`): then Nega. */
export const APPROVAL_TIMEOUT_MS = 5 * 60_000

export interface CommandRule {
  readonly id: string
  /** The reason the user reads. */
  readonly reason: ReasonKey
  readonly pattern: RegExp
  /**
   * The same, as Claude Code's permission rules take it: command prefixes,
   * for `Bash(prefix:*)` and `PowerShell(prefix:*)`. `-p` cannot ask, so
   * there these are refused unless the bot's «Sempre» covers them.
   */
  readonly prefixes: readonly string[]
  /**
   * `false`: asked every time, never kept by «Sempre» (second review, BASSI
   * 1-2). What it runs cannot be read, or it can draw a false menu.
   */
  readonly always?: false
}

/*
 * A shell inside the command (B8c review, M2): `bash -c`, `sh -c`, `cmd /c`,
 * `powershell -Command` (or `-EncodedCommand`, which no list can read) and
 * `eval`. What follows is a command too, so the lists apply inside it; and
 * the nesting alone is a danger (`nestedShell`), never let through unasked.
 */
const NESTED = String.raw`\b(?:cmd(?:\.exe)?\s+\/[ck]|(?:ba|z|da|k|fi)?sh(?:\.exe)?\s+(?:-\w+\s+)*-\w*c|(?:pwsh|powershell)(?:\.exe)?\s+(?:-\w+\s+)*?-(?:c|command|e|ec|encodedcommand)|eval)\s+`
/* Words that run the command after them: `env rm`, `xargs rm`, `nohup`, `sudo -u x`, `nice -n 10`. */
const WRAPPER = String.raw`\b(?:sudo|doas|exec|env|command|builtin|nohup|nice|time|timeout|stdbuf|xargs)\s+(?:[^;&|\n'"]*?\s)?`
/*
 * A command word starts the text or follows a separator (`;`, `&`, `|`, `(`,
 * `{`, a backtick, a new line), a nested shell or a wrapper; a quote may open
 * it there, and a path (`/bin/rm`, `C:\Windows\System32\cmd.exe`) or a
 * backslash (`\rm`) may stand before it. A quote anywhere else is a string
 * (`git commit -m 'rm -rf …'`), not a command.
 */
const START = String.raw`(?:^|[;&|({\x60\n]\s*|${NESTED}|${WRAPPER})["']?(?:\\|[^\s;&|'"(]*[\\/])?`
/*
 * The folder of one user (`/home/mario`, `/Users/mario`, `C:\Users\mario`),
 * itself and not what is inside it: projects live there (second check, MEDIO).
 */
const USER_DIR = String.raw`(?:\/(?:home|Users)|[A-Za-z]:[\\/]Users)[\\/][^\\/\s;&|"'*]+[\\/]?\*?`
const ROOT = String.raw`(?:\/|\/\*|~|~\/|\$HOME|\$\{HOME\}|[A-Za-z]:\\?|[A-Za-z]:\\\*|[A-Za-z]:\/|${USER_DIR})`
/*
 * A drive's root or the user's folder, as PowerShell and cmd write them
 * (second check, MEDIO): `C:\`, `~`, `$HOME`, `$env:USERPROFILE`,
 * `%USERPROFILE%`, `C:\Users\mario`, with or without a final separator and `*`.
 */
const WINDOWS_ROOT = String.raw`(?:${USER_DIR}|[A-Za-z]:|~|\$HOME|\$\{HOME\}|\$env:(?:USERPROFILE|HOMEDRIVE|SystemDrive|SystemRoot|windir)|\$\{env:USERPROFILE\}|%(?:USERPROFILE|HOMEDRIVE|SystemDrive|SystemRoot|windir)%)[\\/]?\*?`
const END = String.raw`(?=\s|$|[;&|)"'])`
const re = (source: string) => new RegExp(source, "i")

/** Refused always. */
export const BLOCKED: readonly CommandRule[] = [
  {
    id: "deleteRoot",
    reason: "bots.approval.reason.deleteRoot",
    pattern: re(
      String.raw`${START}rm\s+(?:-[A-Za-z]*\s+|--[a-z-]+\s+)*(?:-[A-Za-z]*[rR][A-Za-z]*|--recursive)(?:\s+-[A-Za-z]+|\s+--[a-z-]+)*\s+["']?${ROOT}["']?${END}|--no-preserve-root`,
    ),
    prefixes: ["rm -rf /", "rm -rf ~", "rm -rf $HOME", "rm -fr /", "rm -fr ~", "rm -r /", "rm -rf --no-preserve-root"],
  },
  {
    id: "deleteDrive",
    reason: "bots.approval.reason.deleteRoot",
    pattern: re(
      String.raw`${START}(?:remove-item|ri|rm|del|erase|rd|rmdir)\b(?:[^;&|\n]*?\s)?["']?${WINDOWS_ROOT}["']?${END}`,
    ),
    prefixes: [
      "Remove-Item -Recurse -Force C:\\",
      "Remove-Item -Recurse -Force ~",
      "Remove-Item -Recurse -Force $env:USERPROFILE",
      "rd /s /q C:\\",
      "rmdir /s /q C:\\",
      "del /s /q C:\\",
    ],
  },
  {
    id: "disk",
    reason: "bots.approval.reason.disk",
    pattern: re(
      String.raw`${START}(?:mkfs(?:\.\w+)?|diskpart|format-volume|clear-disk|remove-partition|initialize-disk|fdisk|parted|wipefs)\b|${START}format\s+[A-Za-z]:|${START}dd\b[^;&|\n]*\bof=\/dev\/|>\s*\/dev\/(?:sd|nvme|disk|hd)|${START}cipher\s+\/w`,
    ),
    prefixes: [
      "mkfs",
      "diskpart",
      "Format-Volume",
      "Clear-Disk",
      "Remove-Partition",
      "format C:",
      "fdisk",
      "wipefs",
      "cipher /w",
    ],
  },
  {
    id: "forkBomb",
    reason: "bots.approval.reason.forkBomb",
    pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    prefixes: [":(){ :|:& };:"],
  },
  {
    id: "power",
    reason: "bots.approval.reason.power",
    pattern: re(
      String.raw`${START}(?:shutdown|reboot|poweroff|halt|stop-computer|restart-computer)\b|${START}init\s+[06]\b`,
    ),
    prefixes: ["shutdown", "reboot", "poweroff", "halt", "Stop-Computer", "Restart-Computer"],
  },
  {
    id: "system",
    reason: "bots.approval.reason.system",
    pattern: re(String.raw`${START}(?:bcdedit|vssadmin\s+delete|reg\s+delete\s+hklm|wmic\s+shadowcopy\s+delete)\b`),
    prefixes: ["bcdedit", "vssadmin delete", "reg delete HKLM", "wmic shadowcopy delete"],
  },
]

/** Asked about. */
export const DANGEROUS: readonly CommandRule[] = [
  {
    id: "recursiveDelete",
    reason: "bots.approval.reason.recursiveDelete",
    pattern: re(
      String.raw`${START}rm\s+(?:[^;&|\n]*\s)?(?:-[A-Za-z]*[rR][A-Za-z]*|--recursive)\b|${START}(?:remove-item|ri)\b[^;&|\n]*-recurse|${START}(?:rd|rmdir)\s+\/s\b|${START}(?:del|erase)\s+(?:[^;&|\n]*\s)?\/s\b|\bfind\b[^;&|\n]*\s-delete\b`,
    ),
    prefixes: ["rm -r", "rm -rf", "rm -fr", "rm -R", "Remove-Item -Recurse", "rd /s", "rmdir /s", "del /s"],
  },
  {
    id: "gitRewrite",
    reason: "bots.approval.reason.gitRewrite",
    pattern: re(
      String.raw`${START}git\s+(?:[^;&|\n]*\s)?(?:push\b[^;&|\n]*(?:\s-f\b|\s--force\b|\s--force-with-lease\b|\s--delete\b|\s\+\S)|reset\s+[^;&|\n]*--hard\b|clean\s+[^;&|\n]*-[A-Za-z]*f|branch\s+[^;&|\n]*-D\b|filter-branch\b|filter-repo\b|checkout\s+(?:--\s+)?\.(?:\s|$)|restore\s+(?:[^;&|\n]*\s)?\.(?:\s|$)|stash\s+(?:drop|clear)\b)`,
    ),
    prefixes: [
      "git push --force",
      "git push -f",
      "git push --force-with-lease",
      "git push --delete",
      "git reset --hard",
      "git clean -f",
      "git clean -fd",
      "git clean -xdf",
      "git branch -D",
      "git filter-branch",
      "git filter-repo",
      "git checkout -- .",
      "git checkout .",
      "git restore .",
      "git stash drop",
      "git stash clear",
    ],
  },
  {
    id: "pipeToShell",
    reason: "bots.approval.reason.pipeToShell",
    pattern: re(
      String.raw`\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^;&\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|fish|python3?|node|perl|ruby|iex|invoke-expression|pwsh|powershell)\b|${START}(?:iex|invoke-expression)\b|\b(?:bash|sh)\s+<\s*\(\s*(?:curl|wget)`,
    ),
    prefixes: ["iex", "Invoke-Expression", "irm", "iwr", "Invoke-WebRequest", "Invoke-RestMethod"],
  },
  {
    id: "elevate",
    reason: "bots.approval.reason.elevate",
    pattern: re(String.raw`${START}(?:sudo|su|doas|runas|gsudo)\b|-verb\s+runas\b`),
    prefixes: ["sudo", "su", "doas", "runas", "gsudo"],
  },
  {
    id: "killProcess",
    reason: "bots.approval.reason.killProcess",
    pattern: re(
      String.raw`${START}(?:kill\s+-(?:9|KILL|s\s+KILL)\b|pkill\b|killall\b|taskkill\b[^;&|\n]*\/f\b|stop-process\b[^;&|\n]*-force\b)`,
    ),
    prefixes: ["kill -9", "kill -KILL", "pkill", "killall", "taskkill /f", "taskkill /F", "Stop-Process -Force"],
  },
  {
    id: "permissions",
    reason: "bots.approval.reason.permissions",
    pattern: re(
      String.raw`${START}(?:chmod\s+(?:-[A-Za-z]*R|[0-7]*777\b)|chown\s+-[A-Za-z]*R|icacls\b[^;&|\n]*\/grant\b|takeown\b|set-acl\b)`,
    ),
    prefixes: ["chmod -R", "chmod 777", "chown -R", "icacls", "takeown", "Set-Acl"],
  },
  {
    id: "systemConfig",
    reason: "bots.approval.reason.systemConfig",
    pattern: re(
      String.raw`${START}(?:setx\b|reg\s+(?:add|delete|import)\b|schtasks\s+\/(?:create|delete|change)\b|crontab\b|systemctl\s+(?:enable|disable|stop|mask)\b|launchctl\b|set-itemproperty\s+[^;&|\n]*hk(?:lm|cu):|new-service\b|sc(?:\.exe)?\s+(?:create|delete|config)\b|git\s+config\s+(?:[^;&|\n]*\s)?--(?:global|system)\b)`,
    ),
    prefixes: [
      "setx",
      "reg add",
      "reg delete",
      "reg import",
      "schtasks /create",
      "schtasks /delete",
      "crontab",
      "systemctl",
      "launchctl",
      "New-Service",
      "sc create",
      "sc delete",
      "git config --global",
      "git config --system",
    ],
  },
  {
    id: "shellStartup",
    reason: "bots.approval.reason.shellStartup",
    pattern: re(
      String.raw`>>?\s*["']?(?:~|\$HOME|\$\{HOME\})\/\.(?:bashrc|bash_profile|profile|zshrc|zprofile|config\/fish)|(?:set-content|add-content|out-file)\b[^;&|\n]*\$profile\b|>>?\s*\$profile\b|>>?\s*["']?\/etc\/`,
    ),
    prefixes: [],
  },
  {
    id: "database",
    reason: "bots.approval.reason.database",
    pattern: re(String.raw`\b(?:drop\s+(?:table|database|schema)|truncate\s+table)\b`),
    prefixes: [],
  },
  {
    id: "publish",
    reason: "bots.approval.reason.publish",
    pattern: re(
      String.raw`${START}(?:npm|pnpm|yarn|bun)\s+publish\b|${START}cargo\s+publish\b|${START}twine\s+upload\b|${START}gh\s+release\s+create\b|${START}docker\s+push\b`,
    ),
    prefixes: [
      "npm publish",
      "pnpm publish",
      "yarn publish",
      "bun publish",
      "cargo publish",
      "twine upload",
      "gh release create",
      "docker push",
    ],
  },
  {
    id: "containers",
    reason: "bots.approval.reason.containers",
    pattern: re(String.raw`${START}docker\s+(?:system\s+prune|volume\s+(?:rm|prune)|rm\s+-f)\b`),
    prefixes: ["docker system prune", "docker volume rm", "docker volume prune", "docker rm -f"],
  },
  {
    id: "nestedShell",
    reason: "bots.approval.reason.nestedShell",
    pattern: re(
      String.raw`\b(?:cmd(?:\.exe)?\s+\/[ck]|(?:ba|z|da|k|fi)?sh(?:\.exe)?\s+(?:-\w+\s+)*-\w*c|(?:pwsh|powershell)(?:\.exe)?\s+(?:-\w+\s+)*?-(?:c|command))\b`,
    ),
    prefixes: ["bash -c", "sh -c", "zsh -c", "cmd /c", "cmd.exe /c", "powershell -Command", "powershell -c", "pwsh -Command", "pwsh -c"],
  },
  {
    /* What runs cannot be read at all: encoded, from a variable, decoded into a shell. */
    id: "opaqueShell",
    reason: "bots.approval.reason.opaqueShell",
    pattern: re(
      String.raw`\b(?:pwsh|powershell)(?:\.exe)?\s+(?:-\w+\s+)*?-(?:e|ec|encodedcommand)\b|\beval\b|\bbase64\s+(?:-d|--decode)\b[^;&\n]*\|`,
    ),
    prefixes: ["powershell -EncodedCommand", "powershell -e", "pwsh -EncodedCommand", "pwsh -e", "eval"],
    always: false,
  },
  {
    /*
     * Straight to the console, past nikcli's JSON: where ADE reads the
     * permission menu, so a command could draw a false one (second review,
     * BASSO 1). B8d, on `nikcli serve`, closes it for good.
     */
    id: "consoleWrite",
    reason: "bots.approval.reason.consoleWrite",
    pattern: re(
      String.raw`>\s*["']?(?:\/dev\/tty|CON|CONOUT\$)["']?(?![\w$.])|\[(?:System\.)?Console\]::|\$host\.UI\b|Permission required|Allow once`,
    ),
    prefixes: [],
    always: false,
  },
]

export type Verdict =
  | { readonly kind: "allow"; readonly keys?: readonly string[] }
  | { readonly kind: "block"; readonly rule: CommandRule }
  /**
   * `keys` is what «Sempre» would keep, every one; none when it cannot be
   * kept (a command not read whole). `denyOnly`: the only answer is Nega.
   */
  | { readonly kind: "ask"; readonly keys?: readonly string[]; readonly reason: string; readonly denyOnly?: true }

/*
 * The words of the block list's commands. In a command that may go on past
 * what shows (`cut`), one of them leaves only Nega (B8c review, BASSO 3):
 * what follows could be the rest of a command the list refuses.
 */
const BLOCK_WORDS =
  /(?:^|[^\w-])(?:rm|rmdir|rd|del|erase|ri|remove-item|format|format-volume|mkfs(?:\.\w+)?|dd|diskpart|fdisk|wipefs|parted|clear-disk|remove-partition|initialize-disk|shutdown|reboot|poweroff|halt|stop-computer|restart-computer|init|bcdedit|vssadmin|reg|wmic|cipher)(?![\w-])/i

/**
 * What `command` is: blocked, or every kind of danger in it (B8c review,
 * M3: `rm -rf x && git push --force` is two), or nothing to ask about.
 */
export function classifyCommand(command: string): { blocked?: CommandRule; dangers: readonly CommandRule[] } {
  const text = command.replace(/\r\n?/g, "\n")
  const blocked = BLOCKED.find((rule) => rule.pattern.test(text))
  if (blocked) return { blocked, dangers: [] }
  return { dangers: DANGEROUS.filter((rule) => rule.pattern.test(text)) }
}

/** A bot's «Sempre»: kinds of danger, and folders outside the project, it may go ahead with. */
export type Always = readonly string[]

const outsideKey = (patterns: string) => `outside:${patterns.trim()}`

/**
 * The decision for one question nikcli asks (`permission` and its patterns,
 * as its menu draws them), for a bot with `always`.
 *
 * - `bash`: the block list refuses, `always` never reaches it; a command
 *   maybe cut (`cut`) is asked, always; a command with dangers is asked
 *   unless `always` has every one of them (M3); anything else goes.
 * - `external_directory`: asked unless `always` has that folder.
 * - anything else nikcli asks about (the user's own «ask» rules): asked.
 */
export function decide(permission: string, patterns: string, always: Always, cut = false): Verdict {
  if (permission === "bash") {
    const { blocked, dangers } = classifyCommand(patterns)
    if (blocked) return { kind: "block", rule: blocked }
    // What follows the cut is unknown: never let through unseen, nor on «Sempre».
    if (cut && BLOCK_WORDS.test(patterns)) return { kind: "ask", reason: t("bots.approval.reason.cutBlocked"), denyOnly: true }
    if (cut) return { kind: "ask", reason: t("bots.approval.reason.cut") }
    if (dangers.length === 0) return { kind: "allow" }
    const keys = dangers.map((rule) => rule.id)
    const reason = dangers.map((rule) => t(rule.reason)).join("; ")
    // A danger «Sempre» may not keep: asked every time, with no key to keep.
    if (dangers.some((rule) => rule.always === false)) return { kind: "ask", reason }
    if (keys.every((key) => always.includes(key))) return { kind: "allow", keys }
    return { kind: "ask", keys, reason }
  }
  if (permission === "external_directory") {
    const key = outsideKey(patterns)
    if (always.includes(key)) return { kind: "allow", keys: [key] }
    return { kind: "ask", keys: [key], reason: t("bots.approval.reason.outside") }
  }
  const key = `tool:${permission}`
  if (always.includes(key)) return { kind: "allow", keys: [key] }
  return { kind: "ask", keys: [key], reason: t("bots.approval.reason.tool", permission) }
}

/** `always` with `keys` added once each. The block list has no key: nothing adds it. */
export function withAlways(always: Always, ...keys: readonly string[]): string[] {
  return keys.reduce<string[]>((kept, key) => (kept.includes(key) ? kept : [...kept, key]), [...always])
}

/**
 * Claude Code's refusals: every blocked prefix and, for a bot's turn in the
 * panel (`always` given), every dangerous one its «Sempre» does not cover;
 * for Bash and for PowerShell. `-p` cannot ask mid-turn, so what would be a
 * question is a refusal the thread reports. Without `always` (the voice),
 * only the block list.
 *
 * Weak by construction (B8c review, BASSO 1): a prefix does not see
 * `rm -r -f /`, `bash -c "…"` or `git -C x push --force`. It is a defence
 * more, not a block list: a Claude Code bot's boundary is the tools it is
 * given, and Bash only where it needs it (`runners.ts`).
 */
export function claudeRefusals(always?: Always): string[] {
  const rules = [...BLOCKED, ...(always ? DANGEROUS.filter((rule) => !always.includes(rule.id)) : [])]
  return rules.flatMap((rule) => rule.prefixes.flatMap((prefix) => [`Bash(${prefix}:*)`, `PowerShell(${prefix}:*)`]))
}

/* ── the bot's «Sempre», kept in ADE ─────────────────────────────────────── */

export interface AlwaysStore {
  get(botPath: string): Always
  add(botPath: string, key: string): void
}

const STORE_KEY = "ade.bots.approvals"

/** In `localStorage`, by the bot's file path. A store that fails keeps nothing: every danger is asked again. */
export function localAlwaysStore(
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = globalStorage(),
): AlwaysStore {
  const read = (): Record<string, string[]> => {
    try {
      const parsed = JSON.parse(storage?.getItem(STORE_KEY) ?? "{}") as unknown
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string[]>) : {}
    } catch {
      return {}
    }
  }
  return {
    get: (botPath) => {
      const list = read()[botPath]
      return Array.isArray(list) ? list.filter((key): key is string => typeof key === "string") : []
    },
    add: (botPath, key) => {
      const all = read()
      all[botPath] = withAlways(Array.isArray(all[botPath]) ? all[botPath]! : [], key)
      try {
        storage?.setItem(STORE_KEY, JSON.stringify(all))
      } catch {
        // Not kept: asked again next time, which errs on the safe side.
      }
    },
  }
}

function globalStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage
  } catch {
    return undefined
  }
}
