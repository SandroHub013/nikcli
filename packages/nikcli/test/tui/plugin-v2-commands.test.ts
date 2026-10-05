import { describe, expect, it } from "bun:test"
import type { TuiKeymapCommand, TuiKeymapLayer, TuiPluginApi } from "@nikcli-ai/plugin/tui"
import { Plugin } from "@nikcli-ai/plugin/v2/tui"
import { readV2TuiPlugin } from "@tui/plugin/v2"

/**
 * EOT-14: the v2 context now has a command surface, which is what stood between
 * the seventeen v1 internal plugins and a migration that keeps their slash commands.
 */
function host() {
  // Both forms, because `registerLayer` takes both: this harness has to hold what
  // it is handed, not only the shape it used to receive.
  const layers: (TuiKeymapLayer | (() => TuiKeymapLayer))[] = []
  const dialogs: unknown[] = []
  let layerDisposals = 0
  const api = {
    client: {},
    data: {},
    storage: {},
    keymap: {
      registerLayer(layer: TuiKeymapLayer | (() => TuiKeymapLayer)) {
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
  // Mirrors `resolveLayer` and `resolveList` in `packages/tui/src/plugin/keymap.ts`:
  // both the layer and its command list may be a thunk, which is how the palette
  // re-reads a registration on every open. Resolving only the inner list would
  // have silently hidden the dynamic path this file exists to cover.
  const commands = () =>
    layers.flatMap((layer) => {
      const resolved = typeof layer === "function" ? layer() : layer
      return typeof resolved.commands === "function" ? resolved.commands() : (resolved.commands ?? [])
    })
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
          unregister = ctx.ui.command({
            name: "dup.one",
            title: "One",
            run() {},
          })
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

describe("v2 command presentation is re-read, not captured", () => {
  /**
   * The property this pins, and the reason it needs two reads rather than one.
   *
   * The command palette re-runs a registration's callback on every open
   * (`createMemo` in the command dialog). That only re-reads what the callback
   * reads — a value captured into an object literal is read once, at
   * registration, and the palette then shows a snapshot from load time. A test
   * that registers and asserts once passes against the old static array and
   * proves nothing, which is why every case here reads twice with the store
   * changed in between.
   *
   * `name` stays static by design: it is the dedupe and dispatch key, so a
   * command whose identity changes between reads would be two commands sharing
   * one name.
   */
  async function readTwice(setup: (ctx: never, read: () => { on: boolean; label: string }) => void) {
    const { api, commands } = host()
    const store = { on: false, label: "Off" }
    const read = () => store
    const module = load(
      Plugin.define({
        id: "internal:example",
        setup: (ctx) => setup(ctx as never, read),
      }),
    )
    await module.tui(api, undefined, {
      id: "internal:example",
      state: "first",
    } as never)

    const before = (commands() as TuiKeymapCommand[]).map((c) => ({
      name: c.name,
      title: c.title,
      enabled: c.enabled,
    }))
    store.on = true
    store.label = "On"
    const after = (commands() as TuiKeymapCommand[]).map((c) => ({
      name: c.name,
      title: c.title,
      enabled: c.enabled,
    }))
    return { before, after }
  }

  it("picks up a title and enabled state that change between palette opens", async () => {
    const { before, after } = await readTwice((ctx, read) => {
      ;(ctx as { ui: { command: (c: unknown) => void } }).ui.command({
        name: "example.toggle",
        title: () => `Example: ${read().label}`,
        enabled: () => read().on,
        run() {},
      })
    })

    expect(before).toEqual([{ name: "example.toggle", title: "Example: Off", enabled: false }])
    expect(after).toEqual([{ name: "example.toggle", title: "Example: On", enabled: true }])
  })

  it("keeps a static command byte-identical across reads", async () => {
    // The change must not cost a command written in the old style: a plain value
    // still resolves, and resolving twice gives the same answer.
    const { before, after } = await readTwice((ctx, read) => {
      ;(ctx as { ui: { command: (c: unknown) => void } }).ui.command({
        name: "example.static",
        title: "Example",
        description: "A static command",
        namespace: "Tool",
        run() {},
      })
    })

    expect(before).toEqual(after)
    expect(after).toEqual([{ name: "example.static", title: "Example", enabled: undefined }])
  })

  it("leaves the name static even when everything else is dynamic", async () => {
    const { before, after } = await readTwice((ctx, read) => {
      ;(ctx as { ui: { command: (c: unknown) => void } }).ui.command({
        name: "example.fixed",
        title: () => `Label ${read().label}`,
        hidden: () => read().on,
        suggested: () => read().on,
        run() {},
      })
    })

    // One command, one identity, both reads — a name that moved with the store
    // would register twice and dedupe would reject it.
    expect(before.map((c) => c.name)).toEqual(["example.fixed"])
    expect(after.map((c) => c.name)).toEqual(["example.fixed"])
    expect(after[0]?.title).toBe("Label On")
  })
})
