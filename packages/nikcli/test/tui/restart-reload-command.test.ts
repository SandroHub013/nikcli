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
  it("is a slash command that goes through the exit context's restart", async () => {
    const app = stripComments(await tuiSource("app.tsx"))
    expect(app).toContain('value: "nikcli.restart"')
    expect(app).toContain('name: "restart"')
    expect(app).toContain("void runRestart()")
    // Not `exit()`: a restart must reach the host's `onRestart`, and the
    // process-level relaunch is the host's decision, not this component's.
    expect(app).toContain("await restart()")
  })

  it("shows the dialog, then paints it, then does the host's slow work, then tears down", async () => {
    const app = stripComments(await tuiSource("app.tsx"))
    const dialog = app.indexOf("dialog.replace(() => <DialogRestart")
    const paint = app.indexOf("await afterPaint(renderer)")
    const prepare = app.indexOf("await props.onRestartPrepare?.()")
    const teardown = app.indexOf("await restart()")
    expect(dialog).toBeGreaterThan(-1)
    // The order *is* the feature: the seconds the service takes to come back
    // have to happen in front of a user who can see them.
    expect(paint).toBeGreaterThan(dialog)
    expect(prepare).toBeGreaterThan(paint)
    expect(teardown).toBeGreaterThan(prepare)
  })

  it("keeps the terminal when the host could not restart, rather than tearing it down", async () => {
    const app = stripComments(await tuiSource("app.tsx"))
    const failure = app.indexOf("restart failed before the terminal was released")
    expect(failure).toBeGreaterThan(-1)
    const after = app.slice(failure, app.indexOf("await restart()", failure))
    expect(after).toContain("dialog.clear()")
    expect(after).toContain("return")
  })

  it("hands the whole restart contract down to the component that owns the command", async () => {
    // Three props, and the call site once forwarded only the first: the command
    // then had a `restart` to call and nothing to run before it, so the dialog
    // flashed and the slow half happened behind a destroyed renderer.
    const app = stripComments(await tuiSource("app.tsx"))
    expect(app).toContain("onRestart={input.onRestart}")
    expect(app).toContain("onRestartPrepare={input.onRestartPrepare}")
    expect(app).toContain("restartTarget={input.restartTarget}")
  })

  it("says a host with no backend cannot restart, instead of doing nothing", async () => {
    const app = stripComments(await tuiSource("app.tsx"))
    expect(app).toContain("if (!props.onRestart)")
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
  it("restarts the background service and relaunches, naming it in the dialog", async () => {
    const host = stripComments(await source("cli/handlers/default.ts"))
    expect(host).toContain("await BackgroundService.restart()")
    expect(host).toContain("onRestart: relaunchSelf")
    expect(host).toContain('restartTarget: "background service"')
    // The private path has no service: its worker is the server, and stopping it
    // is the slow half.
    expect(host).toContain("onRestartPrepare: stop,")
    expect(host).toContain('restartTarget: "server"')
  })

  it("gives the CLI and the TUI one restart sequence", async () => {
    const service = stripComments(await source("service/service.ts"))
    expect(service).toContain("export async function restart()")
    const handler = stripComments(await source("cli/handlers/service/restart.ts"))
    expect(handler).toContain("await BackgroundService.restart()")
    // One definition, or the two drift: the CLI's `service restart` and the
    // TUI's `/restart` must stop and start in the same order.
    expect(handler).not.toContain("BackgroundService.stop()")
  })
})
