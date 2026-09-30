import { describe, expect, it } from "bun:test"
import type { TuiKeymapCommand, TuiKeymapLayer, TuiPluginApi } from "@nikcli-ai/plugin/tui"
import { Plugin } from "@nikcli-ai/plugin/v2/tui"
import { readV2TuiPlugin } from "@tui/plugin/v2"

/**
 * EOT-14: the v2 context now has a command surface, which is what stood between
 * the seventeen v1 internal plugins and a migration that keeps their slash commands.
 */
function host() {
  const layers: TuiKeymapLayer[] = []
  const dialogs: unknown[] = []
  let layerDisposals = 0
  const api = {
    client: {},
    data: {},
    storage: {},
    keymap: {
      registerLayer(layer: TuiKeymapLayer) {
        layers.push(layer)
        return () => {
          layerDisposals++
        }
      },
    },
    ui: {
      dialog: {
        replace(render: () => unknown) {
          dialogs.push(render)
        },
        clear() {},
      },
    },
    lifecycle: { onDispose: () => () => {} },
  } as unknown as TuiPluginApi
  const commands = () =>
    layers.flatMap((layer) => (typeof layer.commands === "function" ? layer.commands() : (layer.commands ?? [])))
  return { api, layers, dialogs, commands, disposals: () => layerDisposals }
}

const load = (definition: Plugin.Definition) => readV2TuiPlugin({ default: definition }, "file:///plugin.ts")!

describe("v2 tui plugin commands", () => {
  it("registers a command through the same keymap layer a v1 plugin uses", async () => {
    const { api, commands } = host()
    await load(
      Plugin.define({
        id: "internal:example",
        setup(ctx) {
          ctx.ui.command({
            name: "example.open",
            title: "Example",
            namespace: "Tool",
            description: "Open the example",
            slash: { name: "example", aliases: ["ex"], arguments: true },
            suggested: true,
            run() {},
          })
        },
      }),
    ).tui(api, undefined, { id: "internal:example", state: "first" } as never)

    const [command] = commands() as TuiKeymapCommand[]
    expect({ ...command, run: typeof command.run }).toEqual({
      name: "example.open",
      title: "Example",
      namespace: "Tool",
      description: "Open the example",
      slashName: "example",
      slashAliases: ["ex"],
      slashArguments: true,
      suggested: true,
      hidden: undefined,
      enabled: undefined,
      run: "function",
    })
  })

  it("passes slash input through to run", async () => {
    const { api, commands } = host()
    const seen: Array<string | undefined> = []
    await load(
      Plugin.define({
        id: "internal:input",
        setup(ctx) {
          ctx.ui.command({
            name: "input.run",
            title: "Input",
            slash: { name: "input", arguments: true },
            run: (input) => seen.push(input),
          })
        },
      }),
    ).tui(api, undefined, {} as never)
    const [command] = commands() as TuiKeymapCommand[]
    command.run("hello")
    command.run()
    expect(seen).toEqual(["hello", undefined])
  })

  it("opens a dialog through the host stack", async () => {
    const { api, commands, dialogs } = host()
    await load(
      Plugin.define({
        id: "internal:dialog",
        setup(ctx) {
          ctx.ui.command({
            name: "dialog.open",
            title: "Dialog",
            run: () => ctx.ui.dialog.replace(() => null as never),
          })
        },
      }),
    ).tui(api, undefined, {} as never)
    ;(commands() as TuiKeymapCommand[])[0].run()
    expect(dialogs).toHaveLength(1)
  })

  it("refuses a duplicate name and unregisters exactly once", async () => {
    const { api, disposals } = host()
    let unregister!: () => void
    let duplicate: unknown
    await load(
      Plugin.define({
        id: "internal:dup",
        setup(ctx) {
          unregister = ctx.ui.command({ name: "dup.one", title: "One", run() {} })
          try {
            ctx.ui.command({ name: "dup.one", title: "Again", run() {} })
          } catch (error) {
            duplicate = error
          }
        },
      }),
    ).tui(api, undefined, {} as never)
    expect(String(duplicate)).toContain("Command already registered: dup.one")
    unregister()
    unregister()
    expect(disposals()).toBe(1)
  })

  it("is gated on the commands capability when the plugin has a manifest", async () => {
    const manifest = { id: "acme:cmd", version: "1.0.0", kind: "user" }
    const definition = (capabilities: string[]) =>
      Plugin.define({
        id: "acme.cmd",
        manifest: { ...manifest, capabilities } as never,
        setup(ctx) {
          ctx.ui.command({ name: "acme.run", title: "Acme", run() {} })
        },
      })

    // Declared: loads, because the host now supplies `commands`.
    const declared = host()
    await load(definition(["commands"])).tui(declared.api, undefined, {} as never)
    expect(declared.commands()).toHaveLength(1)

    // Not declared: the registration is refused and nothing reaches the keymap.
    const undeclared = host()
    await expect(load(definition(["routes"])).tui(undeclared.api, undefined, {} as never)).rejects.toThrow(/commands/)
    expect(undeclared.commands()).toHaveLength(0)
  })
})

describe("internal:browser as a v2 plugin", () => {
  it("registers the same /browser command the v1 plugin did", async () => {
    const browser = (await import("@tui/feature-plugins/browser")).default
    const { api, commands, dialogs } = host()
    const module = readV2TuiPlugin({ default: browser }, "internal:browser")!
    expect(module.id).toBe("internal:browser")
    await module.tui(api, undefined, {} as never)

    const all = commands() as TuiKeymapCommand[]
    expect(all).toHaveLength(1)
    // The v1 plugin registered exactly this and nothing else: no aliases, no arguments.
    expect({ ...all[0], run: typeof all[0].run }).toEqual({
      name: "browser.sessions",
      title: "Browser Control",
      namespace: "Tool",
      description: "Inspect and manage active background browser sessions",
      slashName: "browser",
      slashAliases: undefined,
      slashArguments: undefined,
      suggested: undefined,
      hidden: undefined,
      enabled: undefined,
      run: "function",
    })
    all[0].run()
    expect(dialogs).toHaveLength(1)
  }, 60_000)
})
