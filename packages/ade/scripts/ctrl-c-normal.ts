/**
 * Runs a command with Ctrl+C working normally in it and in everything it starts.
 *
 * `test:app` starts `tauri dev` detached, so it outlives the launcher. On Windows a detached process is created in a
 * new process group, which sets «ignore Ctrl+C» on it, and every child inherits that: cargo, the app, and the shell in
 * each of its panes. Ctrl+C in a pane of ADE Test stopped nothing, while it works in an ADE started from Explorer.
 * `SetConsoleCtrlHandler(NULL, FALSE)` clears the flag in this process before the rest is created.
 *
 * usage: bun scripts/ctrl-c-normal.ts <program args of bun>
 */
import { dlopen } from "bun:ffi"

if (process.platform === "win32") {
  const kernel32 = dlopen("kernel32.dll", { SetConsoleCtrlHandler: { args: ["ptr", "i32"], returns: "i32" } })
  kernel32.symbols.SetConsoleCtrlHandler(null, 0)
  kernel32.close()
}

const child = Bun.spawn([process.execPath, ...process.argv.slice(2)], {
  stdio: ["ignore", "inherit", "inherit"],
  windowsHide: true,
})
process.exit(await child.exited)
