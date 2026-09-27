import { describe, expect, it } from "bun:test"
import { source, stripComments, tuiSource } from "./tui-source"

/**
 * `/restart` and `/reload`, pinned to the host seam they are built on.
 *
 * Both commands are wires: a slash entry in `app.tsx` whose other end is a host
 * prop, and the host prop is the only layer that knows what a "server" is on
 * this machine — a shared background service, an embedded worker, or somebody
 * else's. Reading the source is the cheap way to catch the two ways that wiring
 * rots: the entry losing its call, and the host losing the other end. Mounting
 * either end would drag in the whole TUI (see `dashboard-command.test.ts` for
 * the same trade).
 */
describe("restart command", () => {
  it("is a slash command that hands the host's restart to runRestart", async () => {
    const app = stripComments(await tuiSource("app.tsx"))
    expect(app).toContain('value: "nikcli.restart"')
    expect(app).toContain('name: "restart"')
    expect(app).toContain("void runRestart(restartBackend)")
  })

  it("keeps the terminal: no exit, no relaunch, a reconnect in place", async () => {
    const app = stripComments(await tuiSource("app.tsx"))
    const run = app.slice(app.indexOf("async function runRestart"), app.indexOf("const connected = useConnected()"))
    expect(run).not.toContain("exit(")
    expect(run).not.toContain("restart()")
    const exit = stripComments(await tuiSource("context/exit.tsx"))
    expect(exit).not.toContain("onRestart")
  })

  it("shows the dialog, paints it, restarts the backend, reconnects, refetches, reloads plugins", async () => {
    const app = stripComments(await tuiSource("app.tsx"))
    const run = app.slice(app.indexOf("async function runRestart"))
    const order = [
      "dialog.replace(() => <DialogRestart",
      "await afterPaint(renderer)",
      "beginRestart()",
      "await restartBackend()",
      "sdk.reconnect(next)",
      "await sync.bootstrap({ fatal: false })",
      "await TuiPluginRuntime.reload()",
    ].map((step) => run.indexOf(step))
    for (const index of order) expect(index).toBeGreaterThan(-1)
    // The order *is* the feature: the seconds the backend takes to come back
    // happen in front of a user who can see them, and plugins bound to the old
    // client are reloaded only once the new one answers.
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it("stays up and says why when the host could not restart", async () => {
    const app = stripComments(await tuiSource("app.tsx"))
    const run = app.slice(app.indexOf("async function runRestart"), app.indexOf("const connected = useConnected()"))
    const failure = run.slice(run.indexOf('log.error("restart failed"'))
    expect(failure).toContain("toast.error(error)")
    // A backend that is down must not turn the refetch into an exit.
    expect(failure).toContain("await sync.bootstrap({ fatal: false })")
    expect(failure.indexOf("await sync.bootstrap({ fatal: false })")).toBeLessThan(failure.indexOf("endRestart()"))
    expect(failure).toContain("dialog.clear()")
  })

  it("never exits on a refetch after the backend went away, in this terminal or any other", async () => {
    // The event stream drops and "reconnects" while the service stops; the
    // refetch that followed hit a server on its way out and `exit(e)` killed the
    // client with status 1 — this one, and every other TUI open on the same
    // shared service when *they* were the ones restarting it.
    const sync = stripComments(await tuiSource("context/sync.tsx"))
    const guard = sync.indexOf("if (!fatal)")
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(sync.indexOf("await exit(e)"))
    // Startup keeps its fatal default; the reconnect path opts out.
    expect(sync).toContain("const fatal = options.fatal ?? true")
    const reconnect = sync.slice(sync.indexOf("reconnectGate.observe(status)"))
    expect(reconnect.indexOf("if (restarting()) return")).toBeLessThan(reconnect.indexOf("refetchAfterReconnect()"))
    const refetch = sync.slice(sync.indexOf("async function refetchAfterReconnect()"))
    expect(refetch).toContain("bootstrap({ fatal: false })")
    expect(refetch).not.toContain("exit(")

    const app = stripComments(await tuiSource("app.tsx"))
    const run = app.slice(app.indexOf("async function runRestart"), app.indexOf("const connected = useConnected()"))
    expect(run).not.toMatch(/sync\.bootstrap\(\)/)
  })

  it("swaps the SDK transport behind getters, so every later request reaches the new backend", async () => {
    const sdk = stripComments(await tuiSource("context/sdk.tsx"))
    expect(sdk).toContain("function reconnect(next: Transport)")
    expect(sdk).toContain("get client()")
    expect(sdk).toContain("get url()")
    expect(sdk).toContain("get fetch()")
    const reconnect = sdk.slice(sdk.indexOf("function reconnect(next: Transport)"))
    // The old stream goes before the new one starts, or both deliver events.
    expect(reconnect.indexOf("sse?.abort()")).toBeLessThan(reconnect.indexOf("subscribe()"))
    expect(reconnect.indexOf("stopEvents()")).toBeLessThan(reconnect.indexOf("subscribe()"))
    expect(reconnect.indexOf("sdk = createSDK()")).toBeLessThan(reconnect.indexOf("subscribe()"))
  })

  it("hands the restart contract down to the component that owns the command", async () => {
    const app = stripComments(await tuiSource("app.tsx"))
    expect(app).toContain("onRestart={input.onRestart}")
    expect(app).toContain("restartTarget={input.restartTarget}")
  })

  it("says a host with no backend cannot restart, instead of doing nothing", async () => {
    const app = stripComments(await tuiSource("app.tsx"))
    expect(app).toContain("if (!restartBackend)")
    expect(app).toContain("This host cannot restart the server it is attached to.")
  })
})

describe("reload command", () => {
  it("reloads the server and this terminal's own config surface", async () => {
    const app = stripComments(await tuiSource("app.tsx"))
    expect(app).toContain('value: "nikcli.reload"')
    expect(app).toContain('name: "reload"')
    // Both halves, in this order: the server owns providers, agents, commands
    // and MCP; the plugin runtime owns the TUI's own plugin set, and only the
    // second one picks up a plugin added since the last pass.
    const server = app.indexOf("sdk.client.config.reload(")
    const terminal = app.indexOf("await TuiPluginRuntime.reload()")
    expect(server).toBeGreaterThan(-1)
    expect(terminal).toBeGreaterThan(server)
  })
})

describe("restart dialog", () => {
  it("spins on the host's own word for what it is restarting, and cannot be dismissed", async () => {
    const dialog = stripComments(await tuiSource("component/dialog-restart.tsx"))
    expect(dialog).toContain("export function DialogRestart")
    expect(dialog).toContain("Spinner")
    expect(dialog).toContain("props.target")
    // A cancel would leave the terminal pointed at a server that is down.
    expect(dialog).not.toContain("useKeyboard")
  })
})

describe("host wiring", () => {
  it("restarts the background service and returns where the new one listens", async () => {
    const host = stripComments(await source("cli/handlers/default.ts"))
    expect(host).toContain("await BackgroundService.restart()")
    expect(host).toContain('restartTarget: "background service"')
    const service = host.slice(host.indexOf("onRestart: async () => {"))
    // Rediscovered, not assumed: a new port, and the credential re-read.
    expect(service.slice(0, service.indexOf("restartTarget"))).toContain("url: next.url")
    expect(service.slice(0, service.indexOf("restartTarget"))).toContain("BackgroundService.password()")
  })

  it("restarts the embedded engine inside its worker instead of relaunching the process", async () => {
    const host = stripComments(await source("cli/handlers/default.ts"))
    expect(host).not.toContain("relaunchSelf")
    expect(host).not.toContain("onRestartPrepare")
    expect(host).toContain('restartTarget: "server"')
    const worker = host.slice(host.lastIndexOf("onRestart: async () => {"))
    const body = worker.slice(0, worker.indexOf('restartTarget: "server"'))
    // Disposes and rebuilds every instance in the same thread: terminating a
    // worker that loaded native modules and spawning another crashed Bun.
    expect(body).toContain('await client.call("reload", undefined)')
    expect(body).not.toContain("new Worker")
    expect(body).not.toContain("terminate")
    expect(body).toContain("return { url, fetch: customFetch, events }")
  })

  it("gives the CLI and the TUI one restart sequence", async () => {
    const service = stripComments(await source("service/service.ts"))
    expect(service).toContain("export async function restart(options: StartOptions = {})")
    const handler = stripComments(await source("cli/handlers/service/restart.ts"))
    expect(handler).toContain("await BackgroundService.restart()")
    // One definition, or the two drift: the CLI's `service restart` and the
    // TUI's `/restart` must stop and start in the same order.
    expect(handler).not.toContain("BackgroundService.stop()")
  })
})
