/**
 * Adapts a v2 TUI plugin definition onto the legacy `TuiPluginModule` shape the
 * runtime already knows how to register, so v1 and v2 plugins coexist in one
 * process without a second plugin system.
 *
 * `specs/effect-tui/14-plugin-v2-architecture.md`: this now validates the
 * manifest (req 2), refuses an incompatible host (req 2), and gates the context
 * surface on declared capabilities (req 6). The revocable per-generation scope
 * (req 4) is still the legacy runtime's.
 */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@nikcli-ai/plugin/tui"
import type { Context, Destination, Route } from "@nikcli-ai/plugin/v2/tui/context"
import type { Definition } from "@nikcli-ai/plugin/v2/tui/plugin"
import {
  CapabilityDenied,
  Incompatible,
  hasManifest,
  parseManifest,
  type Capability,
  type Manifest,
} from "@nikcli-ai/plugin/v2/manifest"
import { isRecord } from "@nikcli-ai/util/record"
import { satisfiesRange } from "@nikcli-ai/util/plugin-shared"

const ROUTE_PREFIX = "__nikcli_v2_tui__:"

/**
 * Resolve a presentation field that may be a thunk.
 *
 * The function form is the whole point of the dynamic command surface: the
 * palette calls this inside its memo, so a plugin reading a reactive store in
 * one of these getters gets the current value on every open. A plain value is
 * returned as-is, which is what every command written before this existed does.
 */
function read<T>(value: T | (() => T)): T {
  return typeof value === "function" ? (value as () => T)() : value
}

function routeName(id: string, name: string) {
  return `${ROUTE_PREFIX}${encodeURIComponent(id)}:${encodeURIComponent(name)}`
}

function parseRouteName(value: string) {
  if (!value.startsWith(ROUTE_PREFIX)) return
  const raw = value.slice(ROUTE_PREFIX.length)
  const index = raw.indexOf(":")
  if (index < 0) return
  try {
    return {
      id: decodeURIComponent(raw.slice(0, index)),
      name: decodeURIComponent(raw.slice(index + 1)),
    }
  } catch {
    return
  }
}

function currentRoute(api: TuiPluginApi): Route {
  const current = api.route.current
  if (current.name === "home") return { type: "home" }
  if (current.name === "session" && typeof current.params?.sessionID === "string") {
    return { type: "session", sessionID: current.params.sessionID }
  }

  const parsed = parseRouteName(current.name)
  const params = "params" in current ? current.params : undefined
  return {
    type: "plugin",
    id: parsed?.id ?? current.name,
    name: parsed?.name ?? current.name,
    data: params,
  }
}

function navigate(api: TuiPluginApi, owner: string, destination: Destination) {
  if (destination.type === "home") {
    api.route.navigate("home")
    return
  }
  if (destination.type === "session") {
    api.route.navigate("session", { sessionID: destination.sessionID })
    return
  }

  const id = "id" in destination ? destination.id : owner
  api.route.navigate(routeName(id, destination.name), destination.data)
}

/**
 * The versions a v2 manifest can require of this host.
 *
 * Read from the running packages rather than hardcoded, so a dependency bump
 * cannot leave a stale number here that silently accepts an incompatible
 * plugin. `nikcli` is supplied by the caller because the TUI package does not
 * own the product version.
 */
export interface Host {
  readonly nikcli?: string
  readonly effect?: string
  readonly opentui?: string
  readonly node?: string
  /** Capabilities this host can actually supply. Requirement 6. */
  readonly capabilities?: readonly Capability[]
}

/**
 * What the TUI runtime can supply today.
 *
 * `storage` is here because the host has it, not because it was on the list:
 * `pluginStorage(base)` is a real per-plugin store — namespaced by plugin id,
 * quota-bounded, watched for changes and evicted on unload
 * (`packages/tui/src/plugin/storage.ts`), and the runtime hands it to every
 * plugin as `api.storage` (`runtime.ts`). Leaving it out meant a manifest
 * declaring `commands` *and* `storage` was refused as `CapabilityDenied` for a
 * capability the host demonstrably had, so no v2 TUI plugin could ask for
 * persistence at all. `scheduler`, `tools`, `keymap` and `http` stay absent
 * because no surface in this host implements them.
 */
export const TUI_HOST_CAPABILITIES: readonly Capability[] = ["routes", "commands", "storage"]

function defaultHost(): Host {
  return {
    node: typeof process !== "undefined" ? process.versions?.node : undefined,
    capabilities: TUI_HOST_CAPABILITIES,
  }
}

/**
 * Refuse a plugin whose manifest asks for a host this is not.
 *
 * A missing host version is not a failure: the host simply cannot answer that
 * requirement, and refusing on "unknown" would make every plugin unloadable in
 * an embedder that does not report its versions. A present-but-unsatisfied
 * version is a hard failure — that is the case the check exists for.
 */
function checkHost(manifest: Manifest, host: Host) {
  const requirements = manifest.hostRequirements
  if (!requirements) return

  for (const key of ["nikcli", "effect", "opentui", "node"] as const) {
    const required = requirements[key]
    if (!required) continue
    const actual = host[key]
    if (!actual) continue
    if (satisfiesRange(actual, required)) continue
    throw new Incompatible({
      pluginID: manifest.id,
      requirement: key,
      required,
      actual,
    })
  }
}

/**
 * Refuse a plugin that asks for something this host cannot supply.
 *
 * Checked at load, not at first call: a plugin that declares `scheduler` on a
 * host with no scheduler is broken whether or not it happens to reach that code
 * path, and finding out at load is the difference between a startup error and a
 * mystery three screens in.
 */
function checkCapabilities(manifest: Manifest, host: Host) {
  const supplied = new Set(host.capabilities ?? TUI_HOST_CAPABILITIES)
  for (const capability of manifest.capabilities) {
    if (supplied.has(capability)) continue
    throw new CapabilityDenied({
      pluginID: manifest.id,
      capability,
      reason: `host does not supply "${capability}" (supplies ${[...supplied].join(", ")})`,
    })
  }
}

/**
 * Deny a capability the plugin did not declare.
 *
 * Throws rather than returning a no-op. A stub would let the plugin believe it
 * registered a route; the failure has to reach the author, and the manifest is
 * where they fix it.
 */
function requireCapability(manifest: Manifest | undefined, capability: Capability, pluginID: string) {
  // No manifest means the pre-manifest v2 shape, which predates gating. It gets
  // the whole surface, the same as before, until its author adds a manifest.
  if (!manifest) return
  if (manifest.capabilities.includes(capability)) return
  throw new CapabilityDenied({
    pluginID,
    capability,
    reason: `plugin did not declare the "${capability}" capability in its manifest`,
  })
}

export function adaptV2TuiPlugin(definition: Definition): TuiPlugin {
  const manifest = definition.manifest
  return async (api, options) => {
    const pages = new Set<string>()
    const slots = new Set<string>()
    const commands = new Set<string>()
    const context: Context = {
      options: options ?? {},
      // Handed over as plain properties. Gating them behind getters changed the
      // shape of the object every existing plugin already receives, for a check
      // that only fires on a manifest none of them carries yet. The capability
      // gate lives on the registration calls below, which is where a denial is
      // both observable and actionable.
      client: api.client,
      data: api.data,
      storage: api.storage,
      ui: {
        router: {
          register(page) {
            requireCapability(manifest, "routes", definition.id)
            if (!page.name) throw new TypeError(`V2 TUI plugin ${definition.id} registered an empty page name`)
            if (pages.has(page.name)) throw new Error(`Route already registered: ${page.name}`)
            pages.add(page.name)
            const dispose = api.route.register([
              {
                name: routeName(definition.id, page.name),
                render: ({ params }) => page.render({ data: params }),
              },
            ])
            let active = true
            return () => {
              if (!active) return
              active = false
              pages.delete(page.name)
              dispose()
            }
          },
          navigate(destination) {
            navigate(api, definition.id, destination)
          },
          current() {
            return currentRoute(api)
          },
        },
        dialog: {
          replace: (render, onClose) => api.ui.dialog.replace(render, onClose),
          clear: () => api.ui.dialog.clear(),
        },
        command(command) {
          requireCapability(manifest, "commands", definition.id)
          if (!command.name) throw new TypeError(`V2 TUI plugin ${definition.id} registered an empty command name`)
          if (commands.has(command.name)) throw new Error(`Command already registered: ${command.name}`)
          commands.add(command.name)
          // A thunk layer, not an object literal. The palette re-reads a
          // registration on every open (`createMemo` in the command dialog), but
          // that only re-reads what the callback reads — and a captured value is
          // read exactly once. Passing a function defers every presentation field
          // into the memo, so a title or enabled state derived from settings is
          // current when the palette opens instead of frozen at registration.
          // `keymap.resolveLayer` already accepts this form, so v1 and v2 share
          // one reactive seam rather than growing a second.
          const dispose = api.keymap.registerLayer(() => ({
            commands: [
              {
                name: command.name,
                title: read(command.title),
                description: read(command.description),
                namespace: read(command.namespace),
                slashName: command.slash?.name,
                slashAliases: command.slash?.aliases ? [...command.slash.aliases] : undefined,
                slashArguments: command.slash?.arguments,
                suggested: read(command.suggested),
                hidden: read(command.hidden),
                enabled: read(command.enabled),
                run: command.run,
              },
            ],
          }))
          let active = true
          return () => {
            if (!active) return
            active = false
            commands.delete(command.name)
            dispose()
          }
        },
        slot(name, render) {
          // Slots register UI surface the same way routes do, so they share the
          // `routes` capability rather than getting one the spec does not name.
          requireCapability(manifest, "routes", definition.id)
          if (!name) throw new TypeError(`V2 TUI plugin ${definition.id} registered an empty slot name`)
          if (slots.has(name)) throw new Error(`Slot already registered: ${name}`)
          slots.add(name)
          const plugin = {
            slots: {
              [name](_context: unknown, props: Record<string, unknown>) {
                return render(props)
              },
            },
          } as unknown as Parameters<TuiPluginApi["slots"]["registerDisposable"]>[0]
          const dispose = api.slots.registerDisposable(plugin)
          let active = true
          return () => {
            if (!active) return
            active = false
            slots.delete(name)
            dispose()
          }
        },
      },
    }

    const cleanup = await definition.setup(context)
    if (cleanup !== undefined && typeof cleanup !== "function") {
      throw new TypeError(`V2 TUI plugin ${definition.id} setup() must return a cleanup function or void`)
    }
    if (cleanup) api.lifecycle.onDispose(cleanup)
  }
}

/**
 * Validate a v2 definition and adapt it, throwing on anything the contract
 * rejects.
 *
 * Extracted from `readV2TuiPlugin` so internal plugins go through the same
 * checks as file plugins. They used to call `adaptV2TuiPlugin` directly, which
 * meant an internal plugin's manifest was read but never parsed, the host was
 * never checked and capabilities were never granted — so "the runtime refuses a
 * plugin whose manifest is incompatible with the host" (requirement 2) did not
 * hold for exactly the plugins shipped in the box. Duplicating the checks in the
 * runtime instead would guarantee the two paths drift again, which is the failure
 * this extraction exists to prevent.
 *
 * No internal plugin carries a manifest today, so this changes nothing until one
 * does — which is the point: the day someone adds one, it is checked.
 */
export function adaptValidatedV2TuiPlugin(value: Record<string, unknown>, spec: string, host?: Host): TuiPlugin {
  if (typeof value.id !== "string" || !value.id.trim()) {
    throw new TypeError(`V2 TUI plugin ${spec} must define a non-empty id`)
  }
  if (typeof value.setup !== "function") {
    throw new TypeError(`V2 TUI plugin ${spec} has an invalid setup export`)
  }

  const resolved = host ?? defaultHost()
  let manifest: Manifest | undefined
  if (hasManifest(value)) {
    manifest = parseManifest(value.manifest, spec)
    checkHost(manifest, resolved)
    checkCapabilities(manifest, resolved)
  }

  return adaptV2TuiPlugin({ ...(value as unknown as Definition), manifest })
}

export function readV2TuiPlugin(raw: Record<string, unknown>, spec: string, host?: Host): TuiPluginModule | undefined {
  const value = raw.default
  if (!isRecord(value) || !("setup" in value)) return

  return {
    // The id stays the plugin's own, manifest or not. The runtime keys slots,
    // routes and enable state on it, so renaming one for diagnostics would be a
    // behaviour change dressed as a label. `manifest.id` is the declared
    // identity and is available on the definition for anything that wants it.
    id: value.id as string,
    tui: adaptValidatedV2TuiPlugin(value, spec, host),
  }
}
