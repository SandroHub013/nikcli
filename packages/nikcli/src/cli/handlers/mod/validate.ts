import path from "path"
import { Runtime } from "../../framework/runtime"
import { passthrough } from "../../framework/args"
import { Commands } from "../../commands"
import { UI } from "@/cli/ui"
import { Config } from "@/config/config"
import { Filesystem } from "@nikcli-ai/util/filesystem"
import { ModGuard } from "@/mod/guard"

/** The entry file of a mod given as its plugin directory, or the file itself. */
async function entryOf(target: string) {
  const resolved = path.resolve(target)
  if (!(await Filesystem.exists(resolved))) return undefined
  const stat = await import("fs/promises").then((fs) => fs.stat(resolved))
  if (!stat.isDirectory()) return resolved
  return Config.pluginFolderEntry(resolved)
}

export default Runtime.handler(Commands.commands["mod"].commands["validate"], async (input) => {
  const args = {
    _: [],
    $0: "nikcli",
    "--": passthrough(),
    directory: String(input["directory"] ?? ""),
    json: input["json"],
    strict: input["strict"],
  }
  const entry = await entryOf(args.directory)
  if (!entry) {
    UI.error(`no mod found at ${args.directory}: expected a plugin directory with an index.ts, or a file`)
    process.exitCode = 1
    return
  }

  const report = ModGuard.validate(await Filesystem.readText(entry))
  const failed = !report.ok || (args.strict && report.warnings.length > 0)

  if (args.json) {
    UI.println(JSON.stringify({ entry, ...report, ok: !failed }, null, 2))
    if (failed) process.exitCode = 1
    return
  }

  const lines = [
    entry,
    `  hooks: ${report.uses.hooks.join(", ") || "(none)"}`,
    `  calls: ${report.uses.calls.join(", ") || "(none)"}`,
    ...(report.uses.envReads.length ? [`  env reads: ${report.uses.envReads.join(", ")}`] : []),
    ...(report.uses.envWrites.length ? [`  env writes: ${report.uses.envWrites.join(", ")}`] : []),
    ...report.warnings.map((warning) => `  warning: ${warning}`),
    ...report.errors.map((error) => `  error: ${error}`),
    failed ? "  not loadable" : "  ok",
  ]
  UI.println(lines.join("\n"))
  if (failed) process.exitCode = 1
})
