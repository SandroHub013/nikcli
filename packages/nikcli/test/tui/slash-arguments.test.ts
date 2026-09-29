import { describe, expect, it } from "bun:test"
import type { TuiCommand, TuiPluginApi } from "@nikcli-ai/plugin/tui"
import { matchSlashArguments, type CommandOption } from "@tui/component/dialog-command"
import type { DialogContext } from "@tui/ui/dialog"
import { createKeymapApi } from "@tui/plugin/keymap"
import { tuiSource } from "./tui-source"

/** The rows a plugin layer registers, as the host registry would hold them. */
function register(layer: Parameters<ReturnType<typeof createKeymapApi>["registerLayer"]>[0]) {
  const registrations: Array<() => TuiCommand[]> = []
  const command: TuiPluginApi["command"] = {
    register(cb) {
      registrations.push(cb)
      return () => {}
    },
    trigger() {},
    show() {},
  }
  createKeymapApi(command).registerLayer(layer)
  return registrations.flatMap((cb) => cb()) as CommandOption[]
}

const dialog = {} as DialogContext

describe("argument-taking slash commands", () => {
  it("hands the text after the name to the plugin, pasted lines included", () => {
    const seen: Array<string | undefined> = []
    const rows = register({
      commands: [
        {
          name: "session.aside",
          title: "Ask a side question",
          slashName: "btw",
          slashAliases: ["aside"],
          slashArguments: true,
          run: (input) => seen.push(input),
        },
      ],
    })
    expect(rows[0]!.slash).toEqual({ name: "btw", aliases: ["aside"], arguments: true })

    matchSlashArguments("/btw why did step 2 fail?", rows)!.run(dialog)
    matchSlashArguments("/aside   first line\nsecond line  ", rows)!.run(dialog)
    matchSlashArguments("/btw\nonly on the next line", rows)!.run(dialog)
    matchSlashArguments("/btw", rows)!.run(dialog)
    expect(seen).toEqual(["why did step 2 fail?", "first line\nsecond line", "only on the next line", ""])

    // The palette and key bindings still run it with no input.
    rows[0]!.onSelect?.(dialog)
    expect(seen.at(-1)).toBeUndefined()
  })

  it("leaves everything else to the model", () => {
    const rows = register({
      commands: [
        { name: "a", title: "A", slashName: "btw", slashArguments: true, run: () => {} },
        { name: "b", title: "B", slashName: "editor", run: () => {} },
        { name: "c", title: "C", slashName: "off", slashArguments: true, enabled: false, run: () => {} },
      ],
    })
    // Plain text, a prefix of the name, a command that takes no input, a
    // disabled one, and a slash that is not at the start.
    for (const text of ["btw what", "/btwx what", "/editor now", "/off please", "see /btw here", "/"]) {
      expect(matchSlashArguments(text, rows)).toBeUndefined()
    }
    expect(rows.find((row) => row.value === "b")!.onArguments).toBeUndefined()
  })
})

describe("/btw wiring", () => {
  it("is a built-in plugin on the argument-taking slash path", async () => {
    const internal = await tuiSource("plugin/internal.ts")
    expect(internal).toContain('import Btw from "../feature-plugins/btw"')
    expect(internal).toMatch(/\n  Btw,\n/)

    const btw = await tuiSource("feature-plugins/btw/index.tsx")
    expect(btw).toContain('slashName: "btw"')
    expect(btw).toContain("slashArguments: true")
    expect(btw).toContain("api.client.session")
    expect(btw).toContain("signal: controller.signal")
  })

  it("dispatches before the prompt creates a session or checks the model", async () => {
    const prompt = await tuiSource("component/prompt/index.tsx")
    const submit = prompt.slice(prompt.indexOf("async function submit("))
    const dispatch = submit.indexOf("command.runSlashArguments(inputText)")
    expect(dispatch).toBeGreaterThan(-1)
    // Pasted content is expanded first, so the command gets the real text.
    expect(submit.indexOf("Expand pasted text inline")).toBeLessThan(dispatch)
    expect(dispatch).toBeLessThan(submit.indexOf("local.model.current()"))
    expect(dispatch).toBeLessThan(submit.indexOf("sdk.client.session.create("))
  })
})
