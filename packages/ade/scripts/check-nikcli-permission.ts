/*
 * Checks the rules of a bot's session on ADE's nikcli server (B8d,
 * `serve-rules.ts`) against nikcli's own code, with no model and no turn:
 * each profile is asked `evaluate`, from
 * `packages/nikcli/src/permission/ruleset.ts`, after an agent made of a user's
 * configuration and a bot file that grants itself everything, as nikcli puts
 * them before a session's rules (`merge(agent.permission, session.permission)`,
 * `session/tools.ts`), where the last rule that matches wins.
 *
 *   bun scripts/check-nikcli-permission.ts
 *
 * It fails when a command of the block list is not denied in a profile that
 * asks about the shell, when an everyday command is not asked or denied as the
 * profile's own shell rule says (nothing is left to the user's rule: the globs
 * count case, Windows does not), when a rule of the profile does not hold over
 * the user's and the bot's, when a subagent, plan mode or a question is not
 * denied, or when a tool denied whole is shown to the model. Run it after
 * touching `serve-rules.ts`.
 */

import { join } from "node:path"
import { botPermission, type BotProfile } from "../src/bots/serve-rules"

const nikcli = join(import.meta.dir, "..", "..", "nikcli")

const rulesetPath: string = join(nikcli, "src", "permission", "ruleset.ts")
const { PermissionRuleset } = (await import(rulesetPath)) as {
  PermissionRuleset: {
    fromConfig(permission: unknown): unknown[]
    evaluate(permission: string, pattern: string, ...rulesets: unknown[][]): { action: string }
    disabled(tools: string[], ruleset: unknown[]): Set<string>
  }
}

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
  "*: allow e basta": { "*": "allow" },
  "scrittura allow": { edit: "allow", write: "allow", repo_clone: "allow", "*": "allow" },
  "tutto allow, poi *": {
    bash: { "git *": "ask", "ls *": "allow" },
    external_directory: "allow",
    computer: "allow",
    browser_control: "allow",
    "*": "allow",
  },
}
/** A bot file that grants itself everything, after the user's configuration. */
const HOSTILE = {
  bash: { "*": "allow", "git *": "allow" },
  external_directory: "allow",
  computer: "allow",
  browser_control: "allow",
  task: "allow",
  edit: "allow",
  "*": "allow",
}
const SHELL: Record<BotProfile, "ask" | "deny"> = {
  ask: "ask",
  "ask-outside": "deny",
  "no-shell": "deny",
  "read-only": "deny",
  "remote-ask": "ask",
  "remote-none": "deny",
}

const failures: string[] = []
let checks = 0
const check = (ok: boolean, what: string) => {
  checks++
  if (!ok) failures.push(what)
}
const action = (agent: unknown[], session: readonly unknown[], pattern: string, tool = "bash") =>
  PermissionRuleset.evaluate(tool, pattern, agent, [...session]).action

let profiles = 0
for (const profile of Object.keys(SHELL) as BotProfile[]) {
  profiles++
  const session = botPermission(profile)
  for (const [user, config] of Object.entries(USERS)) {
    const agent = [...PermissionRuleset.fromConfig(config), ...PermissionRuleset.fromConfig(HOSTILE)]
    if (SHELL[profile] === "ask") {
      for (const command of BLOCKED) {
        const got = action(agent, session, command)
        check(got === "deny", `profilo ${profile}, ${user}: «${command}» dà ${got}, doveva essere negato`)
      }
    }
    // Nothing is left to the user's rule: an everyday command is asked, where ADE answers, or denied with the shell.
    for (const command of EVERYDAY) {
      const got = action(agent, session, command)
      check(got === SHELL[profile], `profilo ${profile}, ${user}: «${command}» dà ${got}, doveva dare ${SHELL[profile]}`)
    }
    // Every rule of the profile for a whole tool holds over the user's and the bot's.
    for (const rule of session) {
      if (rule.pattern !== "*" || rule.permission === "bash") continue
      for (const pattern of ["C:/fuori/progetto", "x"]) {
        const got = action(agent, session, pattern, rule.permission)
        check(got === rule.action, `profilo ${profile}, ${user}: ${rule.permission} «${pattern}» dà ${got}, doveva dare ${rule.action}`)
      }
    }
    for (const tool of ["task", "plan_enter", "plan_exit", "question"]) {
      check(action(agent, session, "*", tool) === "deny", `profilo ${profile}, ${user}: ${tool} non è negato`)
    }
    // A tool denied whole is not shown to the model (`disabled`, ruleset.ts).
    const merged = [...agent, ...session]
    if (SHELL[profile] === "deny") {
      check(PermissionRuleset.disabled(["bash"], merged).has("bash"), `profilo ${profile}, ${user}: la shell negata resta visibile al modello`)
    }
    // A routine only reads (B11 review): every tool that writes is hidden, by nikcli's own tool names.
    if (profile === "read-only") {
      const writers = ["edit", "write", "multiedit", "apply_patch", "patch", "repo_clone", "generate_image", "artifact"]
      const hidden = PermissionRuleset.disabled(writers, merged)
      for (const tool of writers) check(hidden.has(tool), `profilo ${profile}, ${user}: ${tool} resta visibile al modello`)
      check(action(agent, session, "src/index.ts", "read") !== "deny", `profilo ${profile}, ${user}: anche la lettura è negata`)
    }
  }
}

console.log(`${profiles} profili, ${checks} controlli su ruleset.ts di nikcli`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
console.log("tutto regge")
