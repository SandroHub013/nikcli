import { Option } from "effect"
import { EOL } from "os"
import { Runtime } from "../framework/runtime"
import { Commands } from "../commands"
import { Migrate } from "@/migrate/migrate"

const SAY: Record<Migrate.Status, string> = {
  move: "will move",
  done: "already ragu",
  both: "both names exist: left alone, choose one by hand",
  none: "nothing there",
  unmarked: "not moved by migrate: left alone",
}

export default Runtime.handler(Commands.commands["migrate"], async (input) => {
  const apply = Option.getOrUndefined(input["apply"]) === true
  const back = Option.getOrUndefined(input["rollback"]) === true
  const roots = Migrate.roots()
  const report = back ? await Migrate.rollback({ roots, apply }) : await Migrate.run({ roots, apply })

  if (Option.getOrUndefined(input["json"])) {
    process.stdout.write(JSON.stringify(report, null, 2) + EOL)
    process.exit(report.blocked ? 1 : 0)
  }

  const out = (line: string) => process.stdout.write(line + EOL)
  out(`ragu migrate${back ? " --rollback" : ""}${apply ? " --apply" : " (dry run)"}`)
  for (const step of report.steps) {
    const say = step.status === "move" && report.applied ? "moved" : SAY[step.status]
    out(`  ${step.kind.padEnd(7)} ${step.from} → ${step.to}: ${say}`)
  }
  if (report.backup) out(`  backup of auth.json and the configs: ${report.backup}`)
  if (report.blocked) {
    out(`stopped, nothing moved: ${report.blocked.reason}`)
    if (report.blocked.pids?.length) out(`  processes: ${report.blocked.pids.join(", ")}`)
    process.exit(1)
  }
  if (!apply && report.steps.some((step) => step.status === "move"))
    out(`run it again with --apply to ${back ? "rename them back" : "move them"}; undo with: ragu migrate --rollback --apply`)
  if (report.applied && !back) out("done. To undo: ragu migrate --rollback --apply")
})
