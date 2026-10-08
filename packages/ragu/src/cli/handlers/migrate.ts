import { Option } from "effect"
import { EOL } from "os"
import { Runtime } from "../framework/runtime"
import { Commands } from "../commands"
import { Migrate } from "@/migrate/migrate"

const SAY: Record<Migrate.Status, string> = {
  move: "will move",
  done: "already there",
  both: "both names exist: left alone, choose one by hand",
  none: "nothing there",
  unmarked: "not moved by migrate: left alone",
}

/**
 * The programs running, as the tests set them: only with a test home, so the CLI test does not depend on what
 * runs on the machine that runs it.
 */
function testProcesses(): Partial<Migrate.Deps> {
  const running = process.env.RAGU_TEST_HOME ? process.env.RAGU_TEST_MIGRATE_RUNNING : undefined
  if (running === undefined) return {}
  return { processes: async () => JSON.parse(running) as Migrate.Process[] }
}

export default Runtime.handler(Commands.commands["migrate"], async (input) => {
  const apply = Option.getOrUndefined(input["apply"]) === true
  const back = Option.getOrUndefined(input["rollback"]) === true
  const roots = Migrate.roots()
  const deps = testProcesses()
  const report = back ? await Migrate.rollback({ roots, apply, deps }) : await Migrate.run({ roots, apply, deps })
  // A dry run only says what `--apply` would find: it fails nothing.
  const failed = apply && report.blocked !== undefined

  if (Option.getOrUndefined(input["json"])) {
    process.stdout.write(JSON.stringify(report, null, 2) + EOL)
    process.exit(failed ? 1 : 0)
  }

  const out = (line: string) => process.stdout.write(line + EOL)
  out(`ragu migrate${back ? " --rollback" : ""}${apply ? " --apply" : " (dry run)"}`)
  for (const step of report.steps) {
    const say = report.moved.includes(step.kind) ? "moved" : step.status === "move" && apply ? "not moved" : SAY[step.status]
    out(`  ${step.kind.padEnd(7)} ${step.from} → ${step.to}: ${say}`)
    if (step.fresh)
      out(
        `          ${step.to} was made after migrate (only empty folders or newer files), likely by an old nikcli or ADE:` +
          ` check it, move it aside by hand, then run ragu migrate --rollback --apply again`,
      )
  }
  for (const warning of report.warnings) out(`note: ${warning}`)
  if (report.backup)
    out(`  backup of auth.json and the configs: ${report.backup} (it holds secrets: delete it once you have checked)`)
  if (report.blocked) {
    if (!apply) out(`--apply would stop now: ${report.blocked.reason}`)
    else if (report.moved.length === 0) out(`stopped, nothing moved: ${report.blocked.reason}`)
    else {
      out(`stopped: ${report.blocked.reason}`)
      out(`  these folders ARE moved and could not be put back: ${report.moved.join(", ")}`)
      for (const stuck of report.stuck ?? []) out(`    ${stuck.path}: ${stuck.reason}`)
      out(`  ${back ? "run ragu migrate --apply" : "undo with: ragu migrate --rollback --apply"} once the cause is gone`)
    }
    if (report.blocked.pids?.length) out(`  processes: ${report.blocked.pids.join(", ")}`)
    if (failed) process.exit(1)
    return
  }
  if (!apply && report.steps.some((step) => step.status === "move"))
    out(`run it again with --apply to ${back ? "rename them back" : "move them"}; undo with: ragu migrate --rollback --apply`)
  if (report.applied && !back) out("done. To undo: ragu migrate --rollback --apply")
})
