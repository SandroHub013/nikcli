# EOT-14: Plugin v2 Contracts and Hot Reload

Status: proposed. Tier: 1. Phase: P2. Dependencies: EOT-02, EOT-03, EOT-08, EOT-10.
Owner: `@nikcli-ai/plugin` and TUI/nikcli plugin maintainers. [Roadmap](../ROADMAP.md).

## Problem and Evidence

Evidence B12, B29, B30 in the [register](../README.md): the legacy plugin runtime (`packages/tui/src/plugin/runtime.ts`,
1442 lines) loads internal/v1/v2 plugins, distinguishes success/error/timeout cleanup, tracks generations, and supports
hot reload. The v2 contract (`packages/plugin/src/v2/{effect,promise,tui}`) is the new shape, but the runtime still routes
through the legacy registration path and the `TuiPlugin` / `TuiPluginModule` types. The opportunity is a single
architectural spec for v2: the contract, the runtime seam, hot reload, capability gating, scoped ownership, and the
migration path from v1 to v2.

## Scope and Non-Goals

Define the v2 plugin contract as the canonical shape (effect + promise + tui modules), the runtime seam that loads and
unloads v2 plugins, the hot-reload protocol, and the capability/compatibility gates. Preserve the existing v1 plugins and
internal plugins (background, browser, brain, etc.) — they stay loadable through the legacy path until each is migrated.
Do not introduce a second runtime, allow remote/external plugin loading, change autoload permission defaults, or break
existing v1 plugin compatibility before a tested migration window is open.

## Design and Requirements

1. A v2 plugin is a `V2.Plugin` module exporting `effect` (Effect-side tools/scheduler), `promise` (Promise-side tools), and
   `tui` (TUI-side routes/commands/keymaps). At least one of the three is required; an empty module fails compatibility
   check. The contract is the source of truth; the runtime treats it as a stable API and rejects unknown exports.
2. Manifest: each v2 plugin declares a `manifest` with `id` (scoped, e.g. `org:plugin`), `version` (semver), `kind`
   (`internal`/`user`/`remote-disabled`), `capabilities` (`tools`, `commands`, `routes`, `keymap`, `scheduler`, `storage`,
   `http`), `hostRequirements` (effect version, opentui version, node version), and `permissions` (file system globs,
   network domains, command execution). The runtime refuses to load a plugin whose manifest is incompatible with the host.
3. The runtime is one Effect module per slot: `PluginLoad`, `PluginReload`, `PluginUnload`, `PluginRun`. Each is a scoped
   Effect operation that owns the plugin's lifetime. Quiesce old generation → revoke registrations → dispose acquired
   resources → activate new generation. Activation failure restores the prior validated generation or leaves the plugin
   explicitly disabled; it never runs both generations at once.
4. Each generation gets a revocable `Plugin.Generation` scope: keybindings, slots, routes, subscriptions, timers,
   owned async operations, and host mutations. Revocation happens **before** awaiting plugin cleanup; a late disposer or
   install continuation cannot register into the newer generation. The scope is `Scope.Scope` from Effect, not a Solid
   `onCleanup`, and it composes with the TUI's owner.
5. Hot reload: a file watcher (per-host) emits `Plugin.ReloadRequested(pluginID)`. The runtime serializes reload per
   plugin, validates the new module/compatibility without side effects, quiesces the old generation, disposes it, then
   activates the new one. Validation includes manifest shape, capability grants, schema checks for `tools`/`routes`.
   Failed validation does not dispose the old generation.
6. Capability gating: the host declares the capabilities it can supply at plugin start; the plugin can only call
   capabilities it requested. Missing capabilities disable the corresponding UI actions with a reason; the plugin does
   not invent a stub. The host capability surface is the one EOT-08 already exposes (`configSources`, `upgrade`, `mobile`,
   `serverStart`).
7. Storage: v2 plugins get a scoped key-value store (`Plugin.Storage`) keyed by plugin id. Stores are bounded; a plugin
   cannot read another plugin's store; the runtime evicts store entries on plugin unload. There is no shared global store
   for v2 plugins.
8. Scheduler: a v2 plugin with the `scheduler` capability can register typed `Schedule`s. The runtime enforces non-overlap
   (one run at a time) and bounded retries with `Schedule.exponential`/`Schedule.jittered`. A scheduled task that has
   not finished its previous run does not start a new one.
9. Tools: `V2.EffectTool` and `V2.PromiseTool` schemas share a single declaration. Tool descriptors are typed by the
   contract, generated into the SDK via `generate:httpapi-clients`-equivalent codegen, and validated at load time. Tool
   invocations use `Effect.tryPromise`/`Stream` and respect `Schema.TaggedError`; permission gating follows EOT-17.
10. TUI surface: a v2 `tui` module can register routes, keymaps, slash commands, dialogs, and store keys. The runtime
    merges them into the existing providers (`RouteProvider`, `KeybindProvider`, `DialogProvider`, `CommandProvider`,
    `KVProvider`) without a parallel plugin system. Slot IDs are namespaced under the plugin id to avoid collisions.
11. Compatibility: a v1 plugin continues to load through the legacy runtime. The runtime detects v1 vs v2 by the
    presence of the `manifest` field; both paths can coexist in the same process. Migration is per-plugin, not a flag
    day. Until migrated, the plugin id is reported as `legacy:<id>` for diagnostics.
12. Reload API: a programmatic `Reload(pluginID)` runs the same validation + quiesce + activate path as the file
    watcher. A reloaded plugin that throws during `setup()` is reported as a typed `PluginError.SetupFailed`, never as a
    silent removal.

## Runtime Topology

```text
Host (CLI/embedded/standalone)
  -> PluginLoader (one Effect module)
    -> manifest validation + capability check
    -> scoped generation: register, run, dispose
    -> Storage, Scheduler, Tool, Tui surface (capability-gated)
    -> Hot reload: quiesce → dispose → activate
```

## Failure and Cancellation

Use `Schema.TaggedError`: `PluginError.ManifestInvalid`, `PluginError.Incompatible`, `PluginError.CapabilityDenied`,
`PluginError.SetupFailed`, `PluginError.ReloadConflict`, `PluginError.CleanupTimeout`, `PluginError.StorageQuotaExceeded`.
Cleanup has a per-plugin budget (candidate 5 s) and a process-wide budget; timed-out cleanups revoke capabilities and
record the straggler. A Promise timeout is not evidence the underlying work stopped; the runtime observes the cleanup
finalizer, not the Promise. Migration from v1 to v2 must preserve existing user-visible behavior; behavior changes require
an explicit, separate decision and a flag flip.

## Acceptance and Verification

- A v2 plugin loads in the standalone host and the embedded worker; manifest violations, capability denials, and
  incompatible host versions all fail with typed errors.
- 100 reloads with late registration, throwing disposer, hung disposer, failed import, and incompatible plugin cases:
  exactly one generation is active at any time; owned registrations return to baseline after unload; no double
  registration of the same key/id.
- A v1 plugin continues to load through the legacy path; v1 and v2 plugins can coexist in the same host.
- Storage quotas are enforced; cross-plugin storage reads return `PluginError.Forbidden`; quota exhaustion surfaces as a
  typed failure, not a silent eviction.
- Tool invocations validate inputs against the typed schema and decode outputs before returning; permission gating runs
  before side effects.
- Reload from a programmatic `Reload(pluginID)` produces the same outcome as the file-watcher path.
- Extend `packages/tui/test/plugin`, `packages/nikcli/test/tui/plugin-v2.test.ts`, `packages/nikcli/test/tui/plugin-dispose.test.ts`,
  `packages/nikcli/test/plugin/`, and existing capability tests.
- From `packages/nikcli`: `bun test test/tui/plugin-v2.test.ts test/tui/plugin-dispose.test.ts test/plugin/`. Run
  `packages/tui` smoke (`bun run smoke:standalone`) to confirm no transitive backend import. One final root
  `bun run typecheck` after the slice.
- Meet EOT-01 startup/memory gates; reload latency p95 below the reload budget; reload that runs while streaming does
  not drop events.

## Migration and Rollback

Inventory all existing v1 plugins and classify them. Migrate one internal plugin (`background`) to v2 first, then one
user-facing plugin (`brain` or `observability`), then sweep. Each migration is its own PR with a feature flag that
selects v1 vs v2 loading; the legacy path is removed only when no v1 plugins remain. Roll back by flipping the per-plugin
flag to v1; never delete a manifest or storage entry as part of a migration. Storage entries are additive; a v1 plugin
that has not been migrated sees its data, a v2 plugin sees only its scoped store.

## Discipline Addendum — 2026-09-20

`script/check-plugin-v2.ts` is in CI (commit `644a8f28`). It pins three structural invariants without importing the plugin package, so it costs no build step:

1. `packages/plugin/src/v2/manifest.ts` exports `parseManifest`, `hasManifest`, `Capability`, `ManifestSchema` and the three typed failures, and each failure still carries its `PluginV2*` tag. The tags are what consumers `catchTag` on, so a rename that keeps the code compiling would still break every handler.
2. The tool registry never imports a config-dir tool without consulting `NIKCLI_ALLOW_PLUGIN_AUTOLOAD` or `tool.allow`. Autoload is a hard opt-in: the gate has to be read _before_ the import, because an import is already execution.
3. `packages/nikcli/AGENTS.md` documents the same opt-in. A contract enforced only by a script is one a human reviewer cannot check, and the two drift in opposite directions.

`test/plugin/v2-manifest.test.ts` and `test/plugin/autoload-safety.test.ts` cover the behaviour the gate can only assert structurally.

## What Blocked the Next Migration — 2026-09-30

Inventory of `packages/tui/src/feature-plugins/`, by grep, no code changed. Seven internal plugins are already v2
`Plugin.define` definitions (`home/tips` and the six `sidebar/*`). The other seventeen — browser, computer, island, brain,
chatbot, connectors, devtools, herdr, math, observability, discord, session-studio, system (plugins, fusion), btw,
background, loops, mission — all register their commands through `api.keymap.registerLayer` (a `name`, `slashName`, the
`namespace`, `run`), and two of them (loops, mission) also register a slot.

> **Corrected 2026-10-02.** The claim below that v2 had "no command or slash-command surface" was **stale when written
> and is wrong**. `UI.ui.command` exists (`packages/plugin/src/v2/tui/context.ts:183`), the `commands` capability is in
> the manifest vocabulary and in `TUI_HOST_CAPABILITIES` (`packages/tui/src/plugin/v2.ts:95`), and
> `adaptV2TuiPlugin.command` maps it onto `keymap.registerLayer`
> (`packages/tui/test`/`packages/nikcli/test/tui/plugin-v2-commands.test.ts` covers the parity). The comment at
> `packages/plugin/src/v2/manifest.ts:22-27` naming "routes, storage, http" is stale in the same way — the TUI host
> supplies `routes` and `commands`.
>
> What is actually missing is narrower and was found by running the code rather than reading the type: presentation
> fields were captured, not re-read. That is the "Dynamic command presentation" section below. A stale claim about a
> missing surface is worse than no claim, because the next reader scopes the work from it — this is the second time in
> this catalogue that following a spec's own path turned up a defect, the first being `check-spec-paths`.

So the order in "Migration and Rollback" (`background` first) is still not the next step, but for a different reason than
the one recorded here: not a missing command surface, a captured one. Once presentation is re-read, the smallest plugins
(`browser`, `computer`, 37 and 55 lines, one command each) are the safe first migrations, with a test that the registered
command set is identical before and after.

## Dynamic Command Presentation — 2026-10-02

**Landed.** `UICommand`'s presentation fields became `UICommandValue<Value> = Value | (() => Value)`
(`packages/plugin/src/v2/tui/context.ts`), and `adaptV2TuiPlugin.command` now passes `keymap.registerLayer` a thunk
layer so those reads land inside the palette's `createMemo` (`packages/tui/src/component/dialog-command.tsx:188`).

The gap was one argument, not a missing surface. The palette re-runs a registration's callback on every open, but it can
only re-read what the callback reads — and `adaptV2TuiPlugin` passed an object literal, so `title`, `enabled`, `hidden`,
`suggested`, `description` and `namespace` were read once, at registration. A v1 plugin escapes this because
`keymap.registerLayer` accepts a thunk; v2 did not offer the same seam, so a command whose title or enabled state depends
on settings showed a snapshot from load time. `name` stays static on purpose: it is the dedupe and dispatch key, and a
command whose identity changes between reads would be two commands sharing one name.

Three cases in `packages/nikcli/test/tui/plugin-v2-commands.test.ts` pin it, and each reads **twice with the store
changed in between** — a single snapshot passes against the old static array and proves nothing. Reverting the adapter
to a static layer turns the two dynamic cases red and leaves the static one green, which is how they were confirmed to be
load-bearing. The shared harness also had to learn the layer-thunk form: it mirrored `resolveList` but not
`resolveLayer`, and resolving only the inner list would have hidden the dynamic path from every case in the file.

**This is necessary but not sufficient for a `background` migration.** Its three settings-derived commands now read
correctly, but it also needs an `api.kv` equivalent — v2 `storage` writes `state/tui/plugin/<id>.<key>.json`
(`packages/tui/src/plugin/storage.ts:64-70`), not `kv.json` — and `dialog.tsx:41` / `view.tsx:31` read `useKV()`
directly, so migrating the command surface alone would leave the palette title and the rendered image disagreeing.

**Fixed 2026-10-03, and the premise behind it was wrong.** The `api.kv` equivalent already existed on the v1 surface —
`TuiKV` (`packages/plugin/src/tui.ts:329-333`), handed to every plugin at `runtime.ts:830`. What was missing was only the v2
*forwarding*, and the v2 contract had no `kv` member to forward into. `Context` is now `{options, client, data, storage, kv,
ui}` and `adaptV2TuiPlugin` passes `kv: api.kv`.

Two details make this safe rather than merely compiling. The v2 `KV` is an alias of `TuiKV`, not a lookalike
(`packages/plugin/src/v2/tui/context.ts`), so the two cannot drift into two similar shapes that both typecheck. And the host
hands over the *same object* the component tree holds rather than a wrapper: a wrapper would be free to redirect reads to
`storage`, which is exactly the `state/tui/plugin/<id>.<key>.json` relocation this was meant to prevent. The test asserts
identity, `expect(context.kv).toBe(runtime.api.kv)`, because a structural clone satisfies an equality check and still
reintroduces the desync.

`KVLike` in `feature-plugins/background/store.ts` was already the right shape for this — `{get, set}` — and the plugin already
threads `api.kv` through it, so the desync the paragraph above warned about never applied to `background` specifically: its
command layer and its components both resolved to one `state/kv.json`. What the migration actually needs is the UI surface,
below. The `DialogAlert`/`toast` item on this list is likewise still open and still a grant the host cannot honour.

Two further drifts found while scoping this, independent of the migration:

- `storage` is in the manifest vocabulary but **not** in `TUI_HOST_CAPABILITIES` (`v2.ts:95`), so a manifest wanting
  both `commands` and `storage` is refused as `CapabilityDenied` today — a capability the host demonstrably has.
  **Fixed 2026-10-02.** `pluginStorage(base)` is a real per-plugin store — namespaced by id, quota-bounded, watched for
  changes, evicted on unload (`packages/tui/src/plugin/storage.ts`) — and the runtime hands it to every plugin as
  `api.storage` (`runtime.ts`). So the list now reads `["routes", "commands", "storage"]`, and a case in
  `plugin-v2.test.ts` asserts a manifest declaring all three loads while `scheduler` is still refused. The omission meant
  no v2 TUI plugin could ask for persistence at all.
- `DialogAlert` and `toast` are absent from the v2 `UI` surface, which blocks `computer` independently of everything above.
  Still open: unlike `storage`, no surface implements them, so adding them would be a grant the host cannot honour.

## Roadmap Line 11 Is Blocked — 2026-10-02

The roadmap's next slice reads "migrate one internal plugin (`background`) to v2; verify hot reload with late disposer and
incompatible manifest". Scoped against the tree before writing code, three of its four halves are blocked or already done,
so the line as written cannot be executed as a slice. Status unchanged: proposed, Tier 1/P2.

**The late-disposer half already exists.** `createPluginScope` revokes host registrations _before_ awaiting plugin
cleanup (`packages/tui/src/plugin/runtime.ts:503`), and the `disposed` latch plus the `live()` guard block a late
registration into the newer generation (`runtime.ts:439`, `runtime.ts:744-759`). `test/tui/plugin-dispose.test.ts` covers
it across 318 lines. This half is re-verification, not work.

**"Incompatible manifest" is unreachable for any internal plugin.** `loadInternalPlugin` calls `adaptV2TuiPlugin`
directly (`runtime.ts:402`), skipping `readV2TuiPlugin` (`packages/plugin/src/v2/tui/v2.ts:289-292`) — the only path that
runs `parseManifest`, `checkHost` and `checkCapabilities`. `Definition.manifest` is optional and read unparsed
(`v2.ts:166`), so a manifest added to `background` would be validated by nobody. Separately, `defaultHost()` supplies only
a `node` version (`v2.ts:97-102`), so a `hostRequirements.nikcli` constraint would be skipped even on the external path.

**`background` cannot hot-reload.** `reloadLocalPlugins` filters `source === "file"` (`runtime.ts:1153`), while internal
entries are `source: "internal"` with no `item` (`runtime.ts:413`, `runtime.ts:406-424`). Note that `source`
(`"file" | "npm" | "internal"`, `runtime.ts:75`) and `origin` (`"config" | "runtime" | "internal"`, `runtime.ts:73`) are
different unions, and the filter keys on `source`. Hot reload has to be verified with a file-based v2 plugin.

**The v2 contract cannot hold `background` unchanged.** `Context` is `{options, client, data, storage, ui}`
(`context.ts:218-224`) and `adaptV2TuiPlugin` forwards neither the v1 `api.kv` (`tui.ts:566`) nor `api.state`
(`tui.ts:568`); v2 `storage` writes `state/tui/plugin/<id>.<key>.json` (`storage.ts:64-70`), not `kv.json`. Three of
`background`'s four commands derive `title`, `enabled` and `hidden` from settings at layer-build time
(`feature-plugins/background/index.tsx:30`, `:37`, `:57`, `:60`, `:70-71`), while `adaptV2TuiPlugin.command` registers a
static array (`v2.ts:218-234`). A naive migration therefore relocates persisted user data and desyncs those commands from
`dialog.tsx:41` and `view.tsx:31` — a user-visible change this spec forbids at "Failure and Cancellation".

### The prerequisite that unblocks all four

Route internal `Definition`s through the same validation the file path already uses, so a manifest on an internal plugin
is actually checked. That is the single change that makes "incompatible manifest" reachable for internal plugins, and it
is independent of the migration itself.

**Landed 2026-10-02.** `packages/tui/src/plugin/v2.ts` gained `adaptValidatedV2TuiPlugin`, which holds the id, `setup`,
`parseManifest`, `checkHost` and `checkCapabilities` checks that used to live inline in `readV2TuiPlugin`; the reader
now calls it, and `loadInternalPlugin` (`packages/tui/src/plugin/runtime.ts:399`) calls the same function instead of
`adaptV2TuiPlugin`. Extracting rather than duplicating is the point: two copies of these checks would drift, which is the
failure the extraction exists to prevent. No internal plugin carries a manifest today, so nothing changes until one does —
which is exactly when the check starts earning its keep.

Four cases in `packages/nikcli/test/tui/plugin-v2.test.ts` pin it: an internal definition with an incompatible
`hostRequirements` is refused, one declaring no capability is refused, a valid internal manifest loads and registers its
route, and a manifest-less internal definition stays ungated. Neuter the validation in `adaptValidatedV2TuiPlugin` and
all the refusing cases go red, so they are not vacuous. The check is driven through the exported validator rather than
`loadInternalPlugin`, which is not exported — what is pinned is that the internal path shares the validation, not the call
site, which is the part a refactor may legitimately move.

Two drift items found while scoping, worth fixing regardless of the migration order:

- The inventory above counts seven v2 internal plugins and names `browser` as a candidate; there are nine, and `browser`
  is already migrated with parity coverage in `test/tui/plugin-v2-commands.test.ts:165-192`. The recommendation to take
  `computer` next would hit the missing `api.ui.DialogAlert` / `toast` surface, since v2 `UI` has neither.
- `web/src/pages/docs/tui-plugins.astro:62`, `:65-66`, `:84-107` documents `browser` as v1 and counts 14 built-ins against
  24 registered. `script/check-plugin-v2.ts:34-41` also omits `ManifestSchema`, which this spec's own addendum names at
  item 1.

A per-plugin v1/v2 flag is feasible with the existing `Flag` idioms (precedent `packages/tui/src/plugin/internal.ts:69`),
but the registry is evaluated at import time, so a `const` flag is frozen at startup and unreachable by the reload watcher
— it would have to be a runtime-read value, and that is a separate decision.

## Mods — 2026-10-03

**Landed (server side).** A mod is a plugin module that exports `register(on, options)`; it hooks named events with
`on(event, [matcher], hook)` and each hook receives `($, e, next)` and can observe, rewrite, answer or wrap the event.
This is the Claude Code mods contract, kept identical in logic and fitted to nikcli's structure: one Effect service,
the existing plugin loader, the existing hot reload, the existing `plugin` tool. Status of the spec is unchanged
(proposed): the UI half below has no acceptance tests yet.

Where it lives:

- `packages/nikcli/src/mod/chain.ts` — the chain as an `Effect<T, E, R>`. `E` and `R` are the engine behaviour's own: a
  hook never adds to them, and a failure of the engine always arrives on the typed channel as itself, whichever hook was
  waiting on `next` (the `Cause` crosses the Promise boundary, not a message). Hooks are Promise functions — third-party
  code — so `next` re-enters Effect with `runPromiseWith`; interrupting the event aborts `next.signal` and the engine's own
  fiber. No hook on an event means `final(event)` exactly: not copied, frozen or timed.
- `src/mod/index.ts` — `Mod.Service` (`Context.Service`, `layer`, `defaultLayer`), state in `InstanceState`, one `Scope`
  per mod closed on unload and reload (timers and processes a mod started die with it). Typed failures are
  `Schema.TaggedError`: `ModLoadRefused`, `ModRegisterFailed`, `ModPromptDropped`, `ModPolicyInvalid`.
- `src/mod/api.ts` — the `$` API. Every call is also an event (`fs.read`, `process.run`, …) among the mods that run after
  the caller, answerable with `{ value }` or `{ deny }`; a call pauses the hook's clock, `$.clock.sleep` does not.
- `src/mod/guard.ts` — managed policy, static analysis of a module's source, and `sec-default`, itself a mod.
- `packages/plugin/src/mod.ts` — the author-facing types (`@nikcli-ai/plugin/mod`), checked by `test/mod/types.test.ts`.
- `nikcli mod validate <dir> [--strict] [--json]` — what a mod hooks and calls, read without running it.

Order, outermost first: `sec-default` → the organization's mods (`prependPlugins`, then unlisted) → mods a user installed,
in config order → `appendPlugins` → built-in mods. `PermissionNext.layer` and `Plugin.layer` now require `Mod.Service`;
both `defaultLayer`s provide the one memoized `Mod.defaultLayer`.

Events fired: `plugin.register`, `session.start`, `prompt.submit`, `tool.call`, `tool.check`, `tool.describe`, and every
`$` call. `tool.call` wraps all four execution paths (registry tools, MCP tools, connector tools, model subtasks) and
rethrows nikcli's own error unchanged when no hook replaced the result, so callers keep catching what they always did.
`tool.check` fires inside `PermissionNext.ask` before anyone is asked and carries `rule`, what the rules decided.
Fail-open/fail-closed follows the doc: a hook that throws, times out (10 s of its own time) or returns the wrong shape is
skipped, `.catch` makes it fail closed (1 s).

Policy is read from managed settings only — `mod` in `nikcli.json` under `NIKCLI_MANAGED_CONFIG_DIR`, the system
directory (`/Library/Application Support/nikcli/managed`, `/etc/nikcli/managed`, `%ProgramData%\nikcli\managed`) or the
legacy `~/.config/nikcli/managed` (policy only: the user owns it). Keys: `prependPlugins`, `appendPlugins`,
`allowManagedModsOnly`, `allowModsToOverrideDenyRules`, `disableAllMods`; `NIKCLI_DISABLE_MODS=1` is safe mode. A managed
file that cannot be read fails closed: no user mod loads. An organization's own mods live in `<managed>/plugins/`.
A module whose use of `$` cannot be read statically (alias, destructuring, computed key) is refused, as is one whose
source cannot be read.

Deliberate differences from Claude Code, each a nikcli fact rather than a taste:

- `sec-default` always loads. nikcli has no Team plan to key it on, and the guard only tightens (a deny rule stays a deny).
  A managed `prependPlugins` that omits it leaves it out, as in Claude Code.
- Tool names are nikcli's (`bash`, `edit`, `write`), lower case. A tool's arguments are top-level fields of `tool.call`; an
  argument named like one of nikcli's fields is reachable through `e.input`, which always holds them untouched.
- `tool.check` carries `rule` and `patterns`; a mod refusal surfaces as `PermissionBlockedError` (the agent reads the reason
  and continues), not a turn-ending rejection.
- One process serves many sessions, so `$.session.*` reads the session of the hook that is running (async-local), and
  `$.ui.ask` rejects when there is none.
- Mods run in the server process. The UI half (render sites, panes, `ui.press`) must therefore cross the event stream as
  data, the way Claude Code crosses its worker thread; that is the next slice and is **not** implemented.

**Not implemented, and said so rather than stubbed:** `turn.*`, `session.end/compact/receive/send/append/…`, `command.run`
and `command.describe` (and running a mod's `$.command.register` command from the slash menu), `agent.*`, `config.*`,
`prompt.compose/section/context/attachment`, `skill.prompt`, all of `ui.render`/`ui.press`/…, `telemetry.*`, and the `$`
namespaces `model`, `prompt`, `turn`, `mcp`, `settings`, `audio`, most of `session`, and `ui.open/panes/…`. Hooking one is a
`nikcli mod validate` warning; calling one throws `$.<name> is not available in nikcli yet`. The v1 hooks `permission.ask`,
`chat.headers` and `chat.request` remain declared but never invoked (found 2026-10-02); the `plugin` tool no longer tells
the model they work.

Verification: `bun test test/mod` (chain semantics incl. typed-failure preservation and interruption, loader, `tool.call`
rewrite/answer/retry, `tool.check`, guard and managed policy, hot reload, `prompt.submit`, `tool.describe`, static analysis,
author types). Regression: `test/permission`, `test/plugin`, `test/effect`, `test/tool` unchanged and green.
