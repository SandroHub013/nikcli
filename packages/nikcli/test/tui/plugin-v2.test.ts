import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Global } from "@nikcli-ai/util/global"
import { Flock } from "@nikcli-ai/util/flock"
import { clearPluginStorage, evictPluginStorage, pluginStorage } from "@tui/plugin/storage"
import { Plugin } from "@nikcli-ai/plugin/v2/tui"
import type { Context } from "@nikcli-ai/plugin/v2/tui/context"
import type { TuiDispose, TuiPluginApi, TuiRouteCurrent, TuiRouteDefinition } from "@nikcli-ai/plugin/tui"
import { readV2TuiPlugin, adaptValidatedV2TuiPlugin } from "@tui/plugin/v2"

describe("tui plugin storage quota", () => {
  const budget = 32 * 1024 * 1024
  let original: string | undefined
  let dir: string
  let root: string

  beforeEach(async () => {
    clearPluginStorage()
    root = await mkdtemp(path.join(os.tmpdir(), "nikcli-plugin-storage-"))
    original = process.env.NIKCLI_TEST_HOME
    process.env.NIKCLI_TEST_HOME = root
    dir = path.join(Global.Path.state, "tui", "plugin")
    await mkdir(dir, { recursive: true })
  })

  afterEach(async () => {
    clearPluginStorage()
    if (original === undefined) delete process.env.NIKCLI_TEST_HOME
    else process.env.NIKCLI_TEST_HOME = original
    await rm(root, { recursive: true, force: true })
  })

  function store(id: string) {
    return pluginStorage(id).store("state", { initial: { text: "" } })
  }

  function payload(bytes: number) {
    return JSON.stringify({ text: "x".repeat(bytes - 16) }, null, 2)
  }

  async function observed(check: () => boolean) {
    const deadline = Date.now() + 3_000
    while (!check() && Date.now() < deadline) await Bun.sleep(10)
    expect(check()).toBe(true)
  }

  it("replaces near quota without double counting and keeps memoized hot-reload state", async () => {
    const entry = store("replace")
    await entry[1]((draft) => {
      draft.text = "x".repeat(budget - 32)
    })
    await entry[1]((draft) => {
      draft.text = "y".repeat(budget - 32)
    })
    expect(store("replace")).toBe(entry)
    expect((await Bun.file(path.join(dir, "replace.state.json")).json()).text[0]).toBe("y")
    const memory = pluginStorage("replace").memory("counter", {
      initial: { count: 0 },
    })
    memory[1]((draft) => {
      draft.count++
    })
    expect(pluginStorage("replace").memory("counter", { initial: { count: 0 } })).toBe(memory)
    evictPluginStorage("replace")
    await store("other")[1]((draft) => {
      draft.text = "x".repeat(budget - 32)
    })
  })

  it("accounts for loaded file bytes including whitespace and rejects excess loads", async () => {
    await writeFile(path.join(dir, "loaded.state.json"), payload(budget - 64))
    const loaded = store("loaded")
    await expect(
      store("other")[1]((draft) => {
        draft.text = "x".repeat(100)
      }),
    ).rejects.toThrow("quota exhausted")
    await writeFile(path.join(dir, "excess.state.json"), payload(128))
    expect(() => store("excess")).toThrow("quota exhausted")
    await loaded[1]((draft) => {
      draft.text = "small"
    })
    expect(store("excess")[0].text.length).toBe(112)
  })

  it("updates watcher accounting on growth and shrink and refuses oversized reloads", async () => {
    const watched = store("watched")
    await writeFile(path.join(dir, "watched.state.json"), payload(budget - 64))
    await observed(() => watched[0].text.length === budget - 80)
    const other = store("other")
    await expect(
      other[1]((draft) => {
        draft.text = "x".repeat(100)
      }),
    ).rejects.toThrow("quota exhausted")
    await writeFile(path.join(dir, "watched.state.json"), JSON.stringify({ text: "small" }))
    await observed(() => watched[0].text === "small")
    await other[1]((draft) => {
      draft.text = "x".repeat(budget - 64)
    })
    await writeFile(path.join(dir, "watched.state.json"), payload(1024))
    // A second valid file change provides a watcher barrier after the refused reload.
    const barrier = store("barrier")
    await writeFile(path.join(dir, "barrier.state.json"), JSON.stringify({ text: "seen" }))
    await observed(() => barrier[0].text === "seen")
    expect(watched[0].text).toBe("small")
  })

  it("reserves the shared budget before concurrent different-store writes await", async () => {
    const first = store("first")
    const second = store("second")
    const results = await Promise.allSettled([
      first[1]((draft) => {
        draft.text = "x".repeat(20 * 1024 * 1024)
      }),
      second[1]((draft) => {
        draft.text = "y".repeat(20 * 1024 * 1024)
      }),
    ])
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"])
    expect(await Bun.file(path.join(dir, "second.state.json")).exists()).toBe(false)
    await first[1]((draft) => {
      draft.text = "small"
    })
    await second[1]((draft) => {
      draft.text = "y".repeat(20 * 1024 * 1024)
    })
  })

  it("propagates failed persistence and releases its reservation and temporary file", async () => {
    const failed = store("failed")
    await mkdir(path.join(dir, "failed.state.json"))
    await expect(
      failed[1]((draft) => {
        draft.text = "x".repeat(20 * 1024 * 1024)
      }),
    ).rejects.toThrow()
    expect((await readdir(dir)).filter((file) => file.endsWith(".tmp"))).toEqual([])
    await store("other")[1]((draft) => {
      draft.text = "y".repeat(20 * 1024 * 1024)
    })
  })

  it("fails closed on flock acquisition failure and releases the reservation", async () => {
    const failed = store("failed")
    const acquire = spyOn(Flock, "acquire").mockRejectedValueOnce(new Error("lock unavailable"))
    try {
      await expect(
        failed[1]((draft) => {
          draft.text = "x".repeat(20 * 1024 * 1024)
        }),
      ).rejects.toThrow("lock unavailable")
    } finally {
      acquire.mockRestore()
    }
    expect(await Bun.file(path.join(dir, "failed.state.json")).exists()).toBe(false)
    await store("other")[1]((draft) => {
      draft.text = "y".repeat(20 * 1024 * 1024)
    })
  })

  it("propagates temporary-file write failure and releases the reservation", async () => {
    const failed = store("failed")
    const write = spyOn(Bun, "write").mockRejectedValueOnce(new Error("write unavailable"))
    try {
      await expect(
        failed[1]((draft) => {
          draft.text = "x".repeat(20 * 1024 * 1024)
        }),
      ).rejects.toThrow("write unavailable")
    } finally {
      write.mockRestore()
    }
    expect(await Bun.file(path.join(dir, "failed.state.json")).exists()).toBe(false)
    expect((await readdir(dir)).filter((file) => file.endsWith(".tmp"))).toEqual([])
    await store("other")[1]((draft) => {
      draft.text = "y".repeat(20 * 1024 * 1024)
    })
  })

  for (const invalidate of ["evict", "clear"] as const) {
    it(`${invalidate} during a temporary write cannot commit into a replacement generation`, async () => {
      const old = store("generation")
      let started!: () => void
      let resume!: () => void
      const writing = new Promise<void>((resolve) => (started = resolve))
      const paused = new Promise<void>((resolve) => (resume = resolve))
      const originalWrite = Bun.write
      // Start the real write, signal that it is in flight, and only *then*
      // pause. The pause has to sit between "in flight" and "resolved",
      // because that is the window eviction used to slip through: the temp
      // file exists, yet the entry it belongs to is already gone.
      //
      // `Bun.write` is an overload set and `mockImplementationOnce` needs one
      // signature assignable to every overload, hence the cast.
      const write = spyOn(Bun, "write").mockImplementationOnce((async (...args: Parameters<typeof Bun.write>) => {
        const pending = originalWrite(...args)
        started()
        await paused
        return await pending
      }) as unknown as typeof Bun.write)
      const pending = old[1]((draft) => {
        draft.text = "stale"
      })
      try {
        // Wait for the write to be in flight *before* arming the matcher.
        // `expect(p).rejects` blocks while `p` is still pending-and-paused in
        // this Bun build, so arming first deadlocks the whole file.
        await writing
        if (invalidate === "evict") evictPluginStorage("generation")
        else clearPluginStorage()
        const next = store("generation")
        expect(next).not.toBe(old)
        // A plain `.then` rather than `expect(...).rejects`. The matcher is
        // attached before `resume()` so the rejection is never unhandled, but
        // the assertion is made after the promise settles: `expect(p).rejects`
        // blocks while `p` is pending in this Bun build, and that pending write
        // is deliberately paused until `resume()` — so arming the matcher on
        // it first deadlocks the whole file.
        const outcome = pending.then(
          () => ({ rejected: false, message: "" }),
          (error: unknown) => ({
            rejected: true,
            message: error instanceof Error ? error.message : String(error),
          }),
        )
        resume()
        // Substring, as `toThrow` was: the message names the file it refused to
        // write, and that path is per-run.
        const settled = await outcome
        expect(settled.rejected).toBe(true)
        expect(settled.message).toContain("entry was evicted")
        expect(await Bun.file(path.join(dir, "generation.state.json")).exists()).toBe(false)
        expect(next[0].text).toBe("")
        await next[1]((draft) => {
          draft.text = "current"
        })
        expect((await Bun.file(path.join(dir, "generation.state.json")).json()).text).toBe("current")
        expect((await readdir(dir)).filter((file) => file.endsWith(".tmp"))).toEqual([])
      } finally {
        resume()
        await pending.catch(() => undefined)
        write.mockRestore()
      }
    })
  }

  it("propagates flock release failure without leaking its reservation", async () => {
    const failed = store("failed")
    const lease = await Flock.acquire("plugin-storage-release-test")
    const acquire = spyOn(Flock, "acquire").mockResolvedValueOnce({
      ...lease,
      async release() {
        await lease.release()
        throw new Error("release unavailable")
      },
    })
    try {
      await expect(
        failed[1]((draft) => {
          draft.text = "x".repeat(20 * 1024 * 1024)
        }),
      ).rejects.toThrow("release unavailable")
    } finally {
      acquire.mockRestore()
    }
    expect(await Bun.file(path.join(dir, "failed.state.json")).exists()).toBe(true)
    await failed[1]((draft) => {
      draft.text = "small"
    })
    await store("other")[1]((draft) => {
      draft.text = "y".repeat(20 * 1024 * 1024)
    })
  })
})

function host() {
  const routes: TuiRouteDefinition[] = []
  const slots: Array<Parameters<TuiPluginApi["slots"]["registerDisposable"]>[0]> = []
  const cleanups: TuiDispose[] = []
  let current: TuiRouteCurrent = { name: "home" }
  let routeDisposals = 0
  let slotDisposals = 0

  // One backing object stands in for the single `state/kv.json` instance. A
  // plugin reaching it through `context.kv` and a component reaching it through
  // `useKV()` must see the same value, so the harness models them as two readers
  // over one store rather than two stores that happen to be named the same.
  const kvStore: Record<string, unknown> = {}
  const kv = {
    get: <Value = unknown>(key: string, fallback?: Value) => (kvStore[key] ?? fallback) as Value,
    set: (key: string, value: unknown) => {
      kvStore[key] = value
    },
    ready: true,
  }

  const uiCalls: Array<{ kind: string; payload: unknown }> = []
  const replaced: Array<() => unknown> = []

  const api = {
    client: { marker: "client" },
    data: { marker: "data" },
    kv,
    ui: {
      dialog: {
        replace(render: () => unknown) {
          replaced.push(render)
          uiCalls.push({ kind: "dialog.replace", payload: render })
        },
        clear() {
          uiCalls.push({ kind: "dialog.clear", payload: undefined })
        },
      },
      DialogAlert(props: unknown) {
        uiCalls.push({ kind: "DialogAlert", payload: props })
        return `alert:${String((props as { title?: string })?.title)}`
      },
      toast(input: unknown) {
        uiCalls.push({ kind: "toast", payload: input })
      },
    },
    state: {
      ready: true,
      config: {},
      provider: [],
      path: { state: "", config: "", worktree: "", directory: "" },
      vcs: undefined,
      workspace: { list: () => [], get: () => undefined },
      session: {
        count: () => 0,
        diff: () => [],
        todo: () => [],
        messages: () => [],
        status: () => undefined,
        permission: () => [],
        question: () => [],
      },
      part: () => [],
      lsp: () => [],
      mcp: () => [],
    },
    event: {
      on: () => () => {},
      listen: () => () => {},
    },
    route: {
      register(input: TuiRouteDefinition[]) {
        routes.push(...input)
        return () => {
          routeDisposals++
        }
      },
      navigate(name: string, params?: Record<string, unknown>) {
        current = { name, params }
      },
      get current() {
        return current
      },
    },
    slots: {
      register() {
        return "unused"
      },
      registerDisposable(plugin: Parameters<TuiPluginApi["slots"]["registerDisposable"]>[0]) {
        slots.push(plugin)
        return () => {
          slotDisposals++
        }
      },
    },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose(cleanup: TuiDispose) {
        cleanups.push(cleanup)
        return () => {}
      },
    },
  } as unknown as TuiPluginApi

  return {
    api,
    kv,
    kvStore,
    uiCalls,
    routes,
    slots,
    cleanups,
    current: () => current,
    routeDisposals: () => routeDisposals,
    slotDisposals: () => slotDisposals,
  }
}

describe("v2 tui plugin compatibility", () => {
  it("loads Plugin.define modules and owns routes, slots, navigation, and cleanup", async () => {
    const runtime = host()
    let context: Context | undefined
    let cleaned = 0
    let routeOff: (() => void) | undefined
    let slotOff: (() => void) | undefined
    const definition = Plugin.define({
      id: "example.plugin",
      setup(input) {
        context = input
        routeOff = input.ui.router.register({
          name: "settings",
          render: ({ data }) => `tab:${String(data?.tab)}`,
        })
        slotOff = input.ui.slot("home.bottom", (props) => `slot:${String(props.label)}`)
        return () => {
          cleaned++
        }
      },
    })

    const module = readV2TuiPlugin({ default: definition }, "file:///example.ts")
    expect(module?.id).toBe("example.plugin")
    await module!.tui(runtime.api, { enabled: true }, {} as never)

    expect(context?.options).toEqual({ enabled: true })
    expect(context?.data).toBe(runtime.api.data)
    expect(runtime.routes).toHaveLength(1)
    expect(runtime.slots).toHaveLength(1)

    context!.ui.router.navigate({
      type: "plugin",
      name: "settings",
      data: { tab: "general" },
    })
    expect(runtime.current().name).toBe(runtime.routes[0]!.name)
    expect(context!.ui.router.current()).toEqual({
      type: "plugin",
      id: "example.plugin",
      name: "settings",
      data: { tab: "general" },
    })
    expect(runtime.routes[0]!.render({ params: { tab: "advanced" } })).toBe("tab:advanced")

    const render = Object.values(runtime.slots[0]!.slots)[0]!
    expect(render({} as never, { label: "ready" } as never)).toBe("slot:ready")

    routeOff!()
    slotOff!()
    expect(runtime.routeDisposals()).toBe(1)
    expect(runtime.slotDisposals()).toBe(1)

    await runtime.cleanups[0]!()
    expect(cleaned).toBe(1)
  })

  it("rejects malformed v2 definitions", () => {
    expect(() => readV2TuiPlugin({ default: { id: "", setup() {} } }, "broken")).toThrow("non-empty id")
    expect(() => readV2TuiPlugin({ default: { id: "broken", setup: true } }, "broken")).toThrow("invalid setup export")
  })
})

describe("v2 tui plugin kv", () => {
  it("hands the plugin the same store the view reads, so a command and a dialog row cannot disagree", async () => {
    const runtime = host()
    let context: Context | undefined
    const definition = Plugin.define({
      id: "example.kv",
      setup(input) {
        context = input
        return () => {}
      },
    })

    const module = readV2TuiPlugin({ default: definition }, "file:///kv.ts")
    await module!.tui(runtime.api, {}, {} as never)

    // Identity, not equality: the host hands over the same object the component
    // tree holds, so there is no second copy to fall out of step. A structural
    // clone would satisfy the next assertion and still reintroduce the bug.
    expect(context!.kv).toBe(runtime.api.kv)

    // A command writing settings, and a view reading them back.
    context!.kv.set("background", { enabled: false })
    expect(runtime.kvStore["background"]).toEqual({ enabled: false })
    // The type argument is load-bearing: `TuiKV.get` is generic, so a bare call
    // infers `Value` as `undefined` and asserts nothing. The backing store is
    // `any` at runtime (`context/kv.tsx`), and this is the narrowing a real
    // consumer writes.
    expect(runtime.kv.get<{ enabled: boolean }>("background")).toEqual({ enabled: false })
    expect(context!.kv.get<{ enabled: boolean }>("background")).toEqual({ enabled: false })

    // `get` must still fall back, and `ready` must reach the plugin.
    expect(context!.kv.get("missing", "fallback")).toBe("fallback")
    expect(context!.kv.ready).toBe(true)
  })
})

describe("v2 tui plugin user prompts", () => {
  it("reaches DialogAlert and toast, so a v2 plugin can ask the user something", async () => {
    const runtime = host()
    let context: Context | undefined
    let alertRender: unknown
    const definition = Plugin.define({
      id: "example.prompts",
      setup(input) {
        context = input
        return () => {}
      },
    })

    const module = readV2TuiPlugin({ default: definition }, "file:///prompts.ts")
    await module!.tui(runtime.api, {}, {} as never)

    // `computer` was blocked by exactly this: no way to ask the user anything
    // without seizing the whole dialog stack.
    alertRender = context!.ui.DialogAlert({
      title: "Confirm",
      message: "Run it?",
      onConfirm: () => {},
    })
    expect(alertRender).toBe("alert:Confirm")
    expect(runtime.uiCalls).toContainEqual({
      kind: "DialogAlert",
      payload: { title: "Confirm", message: "Run it?", onConfirm: expect.any(Function) },
    })

    context!.ui.toast({ message: "done", variant: "success", duration: 1200 })
    expect(runtime.uiCalls).toContainEqual({
      kind: "toast",
      payload: { message: "done", variant: "success", duration: 1200 },
    })

    // The dialog stack is still a separate seam, not folded into the alert.
    context!.ui.dialog.replace(() => "dialog-body")
    expect(runtime.uiCalls.map((c) => c.kind)).toEqual(["DialogAlert", "toast", "dialog.replace"])
  })
})

describe("v2 tui plugin manifest", () => {
  const manifest = {
    id: "acme:example",
    version: "1.2.3",
    kind: "user",
    capabilities: ["routes"],
  }

  function withManifest(overrides: Record<string, unknown> = {}, setup: Plugin.Definition["setup"] = () => {}) {
    return {
      default: {
        manifest: { ...manifest, ...overrides },
        id: "example.plugin",
        setup,
      },
    }
  }

  it("keeps the plugin's own id", () => {
    // The runtime keys slots, routes and enable state on the id, so a manifest
    // must not rename the plugin out from under them.
    expect(readV2TuiPlugin(withManifest(), "file:///example.ts")?.id).toBe("example.plugin")
  })

  it("refuses an unscoped id", () => {
    expect(() => readV2TuiPlugin(withManifest({ id: "example" }), "file:///x.ts")).toThrow(/scoped lowercase id/)
  })

  it("refuses a non-semver version", () => {
    expect(() => readV2TuiPlugin(withManifest({ version: "v1" }), "file:///x.ts")).toThrow(/must be semver/)
  })

  it("refuses an unknown kind", () => {
    expect(() => readV2TuiPlugin(withManifest({ kind: "sideloaded" }), "file:///x.ts")).toThrow(/manifest.kind must be/)
  })

  it("refuses a manifest that declares nothing", () => {
    expect(() => readV2TuiPlugin(withManifest({ capabilities: [] }), "file:///x.ts")).toThrow(/at least one capability/)
  })

  it("refuses an unknown capability", () => {
    expect(() => readV2TuiPlugin(withManifest({ capabilities: ["telepathy"] }), "file:///x.ts")).toThrow(
      /unknown capability/,
    )
  })

  it("accepts storage, which this host really supplies", () => {
    // `pluginStorage(base)` is a real per-plugin store — namespaced, quota-bounded,
    // watched and evicted on unload — so the host supplying `storage` is a fact
    // about `pluginStorage`, not a claim. It was missing from
    // `TUI_HOST_CAPABILITIES`, which refused every manifest asking for it.
    expect(() =>
      readV2TuiPlugin(withManifest({ capabilities: ["routes", "commands", "storage"] }), "x.ts"),
    ).not.toThrow()
  })

  it("refuses a capability this host has no surface for", () => {
    expect(() => readV2TuiPlugin(withManifest({ capabilities: ["scheduler"] }), "file:///x.ts")).toThrow(
      /does not supply "scheduler"/,
    )
  })

  it("loads a plugin that declares what it uses", async () => {
    const runtime = host()
    const module = readV2TuiPlugin(
      withManifest({}, (input) => {
        input.ui.router.register({ name: "settings", render: () => "ok" })
      }),
      "file:///example.ts",
    )

    await module!.tui(runtime.api, {}, {} as never)
    expect(runtime.routes).toHaveLength(1)
  })

  it("still loads a definition without a manifest, ungated", async () => {
    // Every internal plugin is written this way. Gating them by default would
    // have been a behaviour change, not a new check.
    const runtime = host()
    const module = readV2TuiPlugin(
      {
        default: Plugin.define({
          id: "internal.example",
          setup(input) {
            input.ui.router.register({ name: "page", render: () => "ok" })
          },
        }),
      },
      "file:///internal.ts",
    )

    expect(module?.id).toBe("internal.example")
    await module!.tui(runtime.api, {}, {} as never)
    expect(runtime.routes).toHaveLength(1)
  })
})

describe("internal v2 definitions are validated too", () => {
  const manifest = {
    id: "acme:internal",
    version: "1.2.3",
    kind: "internal",
    capabilities: ["routes"],
  }

  /**
   * The change under test: `loadInternalPlugin` used to call
   * `adaptV2TuiPlugin` directly, which reads `definition.manifest` but never
   * parses it. So requirement 2 — "the runtime refuses to load a plugin whose
   * manifest is incompatible with the host" — did not hold for exactly the
   * plugins shipped in the box, and an internal plugin could declare anything.
   *
   * Driven through `adaptValidatedV2TuiPlugin`, the function the runtime now
   * calls for internal definitions, because `loadInternalPlugin` itself is not
   * exported. What is pinned is the validation being shared, not the call site.
   */
  it("refuses an internal definition whose host requirement is incompatible", () => {
    expect(() =>
      adaptValidatedV2TuiPlugin(
        {
          manifest: {
            ...manifest,
            hostRequirements: { node: ">=99.0.0" },
          },
          id: "internal.example",
          setup: () => {},
        },
        "internal.example",
      ),
    ).toThrow(/host/)
  })

  it("refuses an internal definition that declares nothing", () => {
    expect(() =>
      adaptValidatedV2TuiPlugin(
        {
          manifest: { ...manifest, capabilities: [] },
          id: "internal.example",
          setup: () => {},
        },
        "internal.example",
      ),
    ).toThrow(/at least one capability/)
  })

  it("accepts a valid internal manifest", async () => {
    const runtime = host()
    const tui = adaptValidatedV2TuiPlugin(
      {
        manifest,
        id: "internal.example",
        setup: (input: Context) => {
          input.ui.router.register({ name: "page", render: () => "ok" })
        },
      },
      "internal.example",
    )

    await tui(runtime.api, {}, {} as never)
    expect(runtime.routes).toHaveLength(1)
  })

  it("leaves a manifest-less internal definition ungated", async () => {
    // Every internal plugin is written this way today. If this changed, adding
    // validation to the internal path would have been a behaviour change rather
    // than a new check.
    const runtime = host()
    const tui = adaptValidatedV2TuiPlugin(
      // Cast exactly as `loadInternalPlugin` does: the validator takes the raw
      // record a module boundary hands it, before it is known to be a
      // `Definition`.
      Plugin.define({
        id: "internal.example",
        setup(input) {
          input.ui.router.register({ name: "page", render: () => "ok" })
        },
      }) as unknown as Record<string, unknown>,
      "internal.example",
    )

    await tui(runtime.api, {}, {} as never)
    expect(runtime.routes).toHaveLength(1)
  })
})
