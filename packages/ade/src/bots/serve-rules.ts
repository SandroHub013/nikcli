/**
 * The permission rules of a bot's session on ADE's nikcli server (B8d).
 *
 * A bot's turn is a prompt to a session of the server the Chat uses
 * (`chat/connection.ts`), with the bot as its agent. nikcli decides a tool
 * call with the last rule that matches: the agent's rules, then the
 * session's, then what the user approved for the project with «always»
 * (`permission/next.ts`, `evaluate`). So the rules put on the session here
 * come after the bot's own file and win over it: a file that grants itself
 * the shell no longer shades ADE's denials, as it did when they were merged
 * into the configuration (`NIKCLI_PERMISSION`, B8c second look).
 *
 * The profiles are the spawn flags of `pty.rs` they replace, rule for rule:
 *
 * - `ask`: the panel and a room. Every command and every step outside the
 *   project is asked, and ADE answers by `approval.ts`; the block list is
 *   denied last, so no answer can let one through.
 * - `ask-outside`: the same, for a bot whose shell is off.
 * - `no-shell`: a turn nobody answers: no shell, nothing outside.
 * - `read-only`: a routine (B11): `no-shell`, and nothing written either.
 * - `remote-ask` and `remote-none`: a chat's turn through a gateway (G5), with
 *   the bot's «Comandi da remoto» on or off.
 *
 * Every profile denies what no bot turn may do: a subagent (a `task` runs in
 * a child session these rules do not reach), plan mode, a question to the
 * user (a bot's thread has nowhere to answer it), and a write to the server's
 * own configuration (`configDenials`).
 *
 * What these rules do not cover, said where it matters (`bots.serve.rulesNote`):
 * an «always» the user gave in the project, in nikcli's TUI too, comes last
 * and still wins, as for the Chat.
 */

import type { PermissionRule } from "../chat/rules"

export type BotProfile = "ask" | "ask-outside" | "no-shell" | "read-only" | "remote-ask" | "remote-none"

const rule = (permission: string, action: PermissionRule["action"], pattern = "*"): PermissionRule => ({ permission, pattern, action })

/*
 * The block list (`BLOCKED` in `approval.ts`) as nikcli's own denials, the
 * same list `pty.rs` put under `b?sh` (B8c review, M1): nikcli refuses these
 * before asking, so no answer from ADE can let one through. Patterns are
 * nikcli's: `*` any text, `?` one character, matched on the command's words
 * joined by one space, quotes kept, case counted. What they cannot see — a
 * command inside `bash -c "…"`, a variable — ADE asks about (M2).
 */
export function blockedBashDenials(): string[] {
  const PREFIXES = ["", "sudo ", "*/", "\\"]
  const ROOTS = ["/", "/?", "~", "~/", "~/?", "$HOME", "$HOME/", "${HOME}", "?:", "?:/", "?:\\", "?:/?", "?:\\?"]
  const QUOTES = ["", '"', "'"]
  // An rm with no target nikcli can see: `rm -rf $HOME` reaches it as `rm -rf`.
  const BARE = ["-r", "-rf", "-fr", "-R", "-Rf", "-fR", "-r -f", "-f -r", "--recursive", "--recursive --force", "--force --recursive"]
  const WINDOWS_DELETE = ["Remove-Item", "ri", "rd", "rmdir", "del", "erase"]
  const DRIVES = ["?:", "?:\\", "?:/", "?:\\?", "?:/?"]
  const HOMES = ["~", "~\\", "~/", "$HOME", "$env:USERPROFILE", "${env:USERPROFILE}", "%USERPROFILE%"]
  const WINDOWS_WORDS = [
    "diskpart",
    "Format-Volume",
    "Clear-Disk",
    "Remove-Partition",
    "Initialize-Disk",
    "shutdown",
    "Stop-Computer",
    "Restart-Computer",
    "bcdedit",
    "vssadmin delete",
    "reg delete HKLM",
    "wmic shadowcopy delete",
  ]
  const WINDOWS_OTHER = ["format ?:*", "cipher /w*", "reg delete HKLM\\*"]
  const UNIX_WORDS = ["mkfs", "fdisk", "wipefs", "parted", "shutdown", "reboot", "poweroff", "halt"]
  const UNIX_OTHER = ["mkfs.*", "dd *of=/dev/*", "init 0", "init 6"]
  const denied: string[] = []
  for (const prefix of PREFIXES) {
    for (const root of ROOTS) {
      for (const quote of QUOTES) {
        denied.push(`${prefix}rm * ${quote}${root}${quote}`)
        denied.push(`${prefix}rm * ${quote}${root}${quote} *`)
      }
    }
    for (const flags of BARE) denied.push(`${prefix}rm ${flags}`)
    denied.push(`${prefix}rm *--no-preserve-root*`)
  }
  for (const command of WINDOWS_DELETE.flatMap(spellings)) {
    for (const drive of DRIVES) {
      for (const quote of QUOTES.slice(0, 2)) {
        denied.push(`${command} * ${quote}${drive}${quote}`)
        denied.push(`${command} * ${quote}${drive}${quote} *`)
      }
    }
  }
  for (const command of WINDOWS_DELETE.flatMap((word) => [word, word.toLowerCase()])) {
    for (const home of HOMES) {
      denied.push(`${command} * ${home}`)
      denied.push(`${command} * ${home} *`)
    }
    for (const drive of DRIVES) {
      denied.push(`${command} ${drive}`)
      denied.push(`${command} ${drive} *`)
    }
  }
  for (const word of WINDOWS_WORDS.flatMap(spellings)) {
    denied.push(word)
    denied.push(`${word} *`)
  }
  denied.push(...WINDOWS_OTHER.flatMap(spellings))
  for (const prefix of PREFIXES.slice(0, 2)) {
    for (const word of UNIX_WORDS) {
      denied.push(`${prefix}${word}`)
      denied.push(`${prefix}${word} *`)
    }
    for (const other of UNIX_OTHER) denied.push(`${prefix}${other}`)
  }
  return [...new Set(denied)]
}

/* `word` as written, in lower case, in upper case and, past five letters, with only its first letter a capital. */
function spellings(word: string): string[] {
  const lower = word.toLowerCase()
  const all = [word, lower, word.toUpperCase()]
  if (word.length > 5) all.push(lower.charAt(0).toUpperCase() + lower.slice(1))
  return [...new Set(all)]
}

/*
 * The server's own configuration, which no bot turn may write, in any profile
 * (reload-proxy review, MEDIO): a `.nikcli` folder, where a file in `tool/` is
 * imported by the server — code run outside every rule of the session, with
 * the shell denied too — and `agent/` holds the bots; and `nikcli.json` or
 * `nikcli.jsonc` anywhere, which open tools, MCP servers and permissions. The
 * server reads them again by itself when they change.
 *
 * Every tool that writes a file asks `edit`: `write`, `patch`, `multiedit`
 * and `apply_patch` are `edit` to nikcli (`TOOL_PERMISSION`, ruleset.ts), so
 * a rule named after them would never match. The pattern is the path as the
 * tool resolved it, relative to the worktree (`path.relative`): `./` gone,
 * backslashes on Windows, absolute on another drive, `..` outside, and the
 * case as the model typed it. The glob counts case and Windows does not, so
 * every casing of «nikcli» is spelled out (64), with `?` for the separator
 * and for the extension's letters, and the short 8.3 names (`NIKCLI~1`) are
 * denied too.
 *
 * They open the session's rules rather than close them: any session rule
 * comes after the bot's file and wins over it, and a routine's `edit` denied
 * whole must stay the last `edit` rule, the one nikcli reads to hide the tool
 * from the model (`disabled`, ruleset.ts).
 */
export function configDenials(): string[] {
  const denied: string[] = []
  for (const name of casings("nikcli")) {
    denied.push(`*.${name}?*`, `*${name}.????`, `*${name}.?????`, `*${name}~*`)
  }
  return denied
}

/* Every way of writing `word` with capitals and small letters. */
function casings(word: string): string[] {
  let all = [""]
  for (const letter of word) {
    all = all.flatMap((start) => [...new Set([start + letter.toLowerCase(), start + letter.toUpperCase()])])
  }
  return all
}

/** What each profile says about the tools the spawn flags named, in their order. */
const PROFILE_RULES: Record<BotProfile, readonly PermissionRule[]> = {
  ask: [rule("bash", "ask"), rule("external_directory", "ask"), rule("computer", "ask"), rule("browser_control", "ask")],
  "ask-outside": [rule("bash", "deny"), rule("external_directory", "ask"), rule("computer", "ask"), rule("browser_control", "ask")],
  "no-shell": [rule("bash", "deny"), rule("external_directory", "deny"), rule("computer", "deny"), rule("browser_control", "deny")],
  "read-only": [
    rule("bash", "deny"),
    rule("external_directory", "deny"),
    rule("computer", "deny"),
    rule("browser_control", "deny"),
    ...["edit", "write", "patch", "repo_clone", "generate_image", "artifact"].map((tool) => rule(tool, "deny")),
  ],
  "remote-ask": [rule("bash", "ask"), rule("external_directory", "ask"), rule("computer", "deny"), rule("browser_control", "deny")],
  "remote-none": [rule("bash", "deny"), rule("external_directory", "ask"), rule("computer", "deny"), rule("browser_control", "deny")],
}

/** What no bot turn may do, whatever its profile. */
const NEVER: readonly PermissionRule[] = ["task", "plan_enter", "plan_exit", "question"].map((tool) => rule(tool, "deny"))

/** The profiles whose shell asks: the block list goes after everything, so its denials win. */
const WITH_BLOCK_LIST = new Set<BotProfile>(["ask", "remote-ask"])

const cache = new Map<BotProfile, readonly PermissionRule[]>()

/** The rules a bot's session is made with, for `profile`. */
export function botPermission(profile: BotProfile): readonly PermissionRule[] {
  let rules = cache.get(profile)
  if (!rules) {
    rules = [
      ...configDenials().map((pattern) => rule("edit", "deny", pattern)),
      ...PROFILE_RULES[profile],
      ...NEVER,
      ...(WITH_BLOCK_LIST.has(profile) ? blockedBashDenials().map((pattern) => rule("bash", "deny", pattern)) : []),
    ]
    cache.set(profile, rules)
  }
  return rules
}

/** The profile of a turn, as `runners.ts` chose its spawn flag. */
export function profileFor(spec: {
  readonly remote?: { readonly commands: boolean }
  readonly unattended?: boolean
  readonly approvals?: boolean
  /** The bot's shell is on (`bash` not among its disabled tools). */
  readonly shell: boolean
}): BotProfile {
  if (spec.remote) return spec.remote.commands ? "remote-ask" : "remote-none"
  if (spec.unattended) return "read-only"
  if (spec.approvals) return spec.shell ? "ask" : "ask-outside"
  return "no-shell"
}

const same = (a: { permission?: unknown; pattern?: unknown; action?: unknown }, b: PermissionRule) =>
  a.permission === b.permission && a.pattern === b.pattern && a.action === b.action

/** Whether a session's rules end with `profile`'s, in order: a session made for this bot's turns. */
export function hasBotRules(session: { readonly permission?: unknown } | undefined, profile: BotProfile): boolean {
  const rules = (Array.isArray(session?.permission) ? session.permission : []) as readonly {
    permission?: unknown
    pattern?: unknown
    action?: unknown
  }[]
  const expected = botPermission(profile)
  if (rules.length < expected.length) return false
  const tail = rules.slice(rules.length - expected.length)
  return tail.every((entry, index) => same(entry, expected[index]!))
}
