import path from "path"
import { mkdir } from "fs/promises"
import { Runtime } from "../../framework/runtime"
import { Commands } from "../../commands"
import { UI } from "@/cli/ui"
import { Filesystem } from "@nikcli-ai/util/filesystem"
import { Global } from "@nikcli-ai/util/global"
import { ModGuard } from "@/mod/guard"
import { ModTemplate } from "@/mod/template"

/**
 * `nikcli mod create <name>`: write a mod that draws on every client.
 *
 * Project mods live in `.nikcli/plugin/<name>/` and load for that project; `--global` puts it in the
 * user's config instead. A running server picks the file up on its own, so nothing needs restarting:
 * the terminal, the phone app, the desktop app and ADE all show it.
 */
export default Runtime.handler(Commands.commands["mod"].commands["create"], async (input) => {
  const name = String(input["name"] ?? "")
  if (!ModTemplate.valid(name)) {
    UI.error(
      `"${name}" is not a usable mod name: use lowercase letters, digits and dashes, starting with a letter or digit`,
    )
    process.exitCode = 1
    return
  }

  const root = input["global"]
    ? path.join(Global.Path.config, "plugins")
    : path.join(process.cwd(), ".nikcli", "plugin")
  const folder = path.join(root, name)
  const entry = path.join(folder, "index.ts")
  if ((await Filesystem.exists(entry)) && !input["force"]) {
    UI.error(`${entry} already exists; pass --force to replace it`)
    process.exitCode = 1
    return
  }

  const source = ModTemplate.source(name)
  // The file written has to be one the server will load: check it as `nikcli mod validate` does.
  const report = ModGuard.validate(source)
  if (!report.ok) {
    UI.error(`the generated mod does not validate: ${report.errors.join("; ")}`)
    process.exitCode = 1
    return
  }

  await mkdir(folder, { recursive: true })
  await Filesystem.write(entry, source)

  UI.println(
    [
      `created ${entry}`,
      "",
      "It runs in the nikcli server and draws on every client from this one file:",
      "  terminal  a dense row in the sidebar",
      "  mobile    a card in More → Mods",
      "  desktop   the Plugins panel in the sidebar",
      "  ade       the Mods section and pane",
      "",
      "Edit it and save: a running server reloads it and every client redraws.",
      `Review what it does with: nikcli mod validate ${path.relative(process.cwd(), folder) || folder}`,
    ].join("\n"),
  )
})
