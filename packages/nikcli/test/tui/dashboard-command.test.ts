import { describe, expect, it } from "bun:test"
import { tuiSource } from "./tui-source"

/**
 * `/dashboard` stays reachable.
 *
 * The dialog is lazily imported by name from `app.tsx`, so a rename or a moved
 * file breaks the command at runtime with nothing failing at build time. Reading
 * the source is the cheap way to catch that — mounting the dialog would drag in
 * the whole TUI (see `profile-command.test.ts` for the same trade).
 */
describe("dashboard command", () => {
  it("is registered with its slash names and lazily loads the dialog", async () => {
    const app = await tuiSource("app.tsx")

    expect(app).toContain('value: "nikcli.dashboard"')
    expect(app).toContain('name: "dashboard"')
    expect(app).toContain('aliases: ["ops", "command-center"]')
    expect(app).toContain("@tui/component/dialog-command-center")
  })

  it("resolves to an exported dialog that tears down its watchers", async () => {
    const dialog = await tuiSource("component/dialog-command-center.tsx")
    expect(dialog).toContain("export function DialogCommandCenter()")
    expect(dialog).toContain("analyticsCtx.watch()")
    expect(dialog).toContain("onCleanup")
    expect(dialog).not.toContain("sdk.url")
  })
})
