/*
 * Checks the `NIKCLI_PERMISSION` of every nikcli spawn flag against nikcli's
 * own code, with no model and no turn (B8c, second review): the value Rust
 * sets is merged over a user's configuration the way nikcli merges it
 * (`mergeDeep`, `config/config.ts`), read by `PermissionRuleset.fromConfig`
 * and asked `evaluate`, from `packages/nikcli/src/permission/ruleset.ts`.
 *
 *   bun scripts/check-nikcli-permission.ts
 *
 * It fails when a flag's value does not parse, when the block list is not its
 * last key, when a command of the list is not denied under any of the user
 * configurations below, or when the list changes what an everyday command
 * gets. Run it after touching `SPAWN_FLAGS` or `blocked_bash_denials` in
 * `pty.rs`: a value nikcli cannot read would stop every bot turn at start.
 */

import { spawnSync } from "node:child_process"
import { join } from "node:path"

const ade = join(import.meta.dir, "..")
const nikcli = join(ade, "..", "nikcli")

const cargo = spawnSync(
  "cargo",
  ["test", "--lib", "--offline", "--", "--ignored", "--exact", "pty::tests::print_nikcli_permission_flags", "--nocapture"],
  { cwd: join(ade, "src-tauri"), encoding: "utf8" },
)
const flags = new Map<string, string>()
for (const line of cargo.stdout.split(/\r?\n/)) {
  const match = /^NIKCLI_PERMISSION_FLAG (\S+) (.*)$/.exec(line)
  if (match) flags.set(match[1]!, match[2]!)
}
if (flags.size === 0) {
  console.error("Nessun flag letto da cargo:\n" + cargo.stderr.slice(-2000))
  process.exit(1)
}

const rulesetPath: string = join(nikcli, "src", "permission", "ruleset.ts")
const { PermissionRuleset } = (await import(rulesetPath)) as {
  PermissionRuleset: {
    fromConfig(permission: unknown): unknown[]
    evaluate(permission: string, pattern: string, ...rulesets: unknown[][]): { action: string }
  }
}
const remedaPath: string = Bun.resolveSync("remeda", nikcli)
const { mergeDeep } = (await import(remedaPath)) as { mergeDeep: (a: object, b: object) => object }

const BLOCK_KEY = "b?sh"
const BLOCKED = [
  "rm -rf ~",
  "rm -rf /",
  "sudo rm -rf /",
  "mkfs.ext4 /dev/x",
  "shutdown /s /t 0",
  "Remove-item -Recurse -Force C:\\",
  "FORMAT C:",
]
const EVERYDAY = ["git status", "ls -la", "rm -rf build", "git push --force origin x", "npm publish"]
const USERS: Record<string, object> = {
  "nessuna regola": {},
  "bash: allow": { bash: "allow" },
  "bash: ask": { bash: "ask" },
  "bash a pattern": { bash: { "*": "allow", "git push *": "ask" } },
  "*: allow dopo bash": { bash: "ask", "*": "allow" },
}

const action = (permission: object, command: string) =>
  PermissionRuleset.evaluate("bash", command, PermissionRuleset.fromConfig(permission)).action

const failures: string[] = []
let checks = 0
const check = (ok: boolean, what: string) => {
  checks++
  if (!ok) failures.push(what)
}

for (const [flag, raw] of flags) {
  let value: Record<string, unknown>
  try {
    value = JSON.parse(raw) as Record<string, unknown>
  } catch (error) {
    failures.push(`${flag}: JSON non valido (${String(error)})`)
    continue
  }
  const keys = Object.keys(value)
  const blocks = keys.includes(BLOCK_KEY)
  if (blocks) check(keys.at(-1) === BLOCK_KEY, `${flag}: ${BLOCK_KEY} non è l'ultima chiave (${keys.join(", ")})`)
  const { [BLOCK_KEY]: _list, ...without } = value
  for (const [user, config] of Object.entries(USERS)) {
    const merged = mergeDeep(config, value)
    const before = mergeDeep(config, without)
    if (blocks) {
      for (const command of BLOCKED) {
        check(action(merged, command) === "deny", `${flag}, ${user}: «${command}» non è negato (${action(merged, command)})`)
      }
    }
    // The list changes nothing else: an everyday command gets what it got
    // without it, or a question where the flag asks about every command.
    for (const command of EVERYDAY) {
      const expected = value["bash"] === "ask" ? "ask" : action(before, command)
      check(
        action(merged, command) === expected,
        `${flag}, ${user}: «${command}» dà ${action(merged, command)}, doveva dare ${expected}`,
      )
    }
    // A flag that asks about the shell keeps asking, whatever the user wrote.
    if (value["bash"] === "ask") check(action(merged, "git status") === "ask", `${flag}, ${user}: «git status» non chiede`)
  }
}

console.log(`${flags.size} flag, ${checks} controlli su ruleset.ts di nikcli`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
console.log("tutto regge")
