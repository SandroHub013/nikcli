import { describe, expect, test } from "bun:test"
import {
  TEST_APP_PORT_BASE,
  TEST_APP_PORT_SPAN,
  devConfig,
  hashPath,
  instanceProcesses,
  instanceRunning,
  type ProcessRow,
  parseRecord,
  planTestApp,
  startFailure,
} from "./test-app"

describe("host/test-app", () => {
  test("the same worktree gets the same port however its path is spelled", () => {
    const a = planTestApp({ root: "C:\\Users\\me\\Favorites\\nikcli-ade", branch: "feat/ade" })
    const b = planTestApp({ root: "c:/users/me/favorites/nikcli-ade/", branch: "feat/ade" })
    expect(a.port).toBe(b.port)
  })

  test("different worktrees get different ports, inside the reserved range", () => {
    const ports = ["nikcli-ade", "nikcli-ade-testapp", "nikcli-ade-release", "nikcli-ade-fix"].map(
      (name) => planTestApp({ root: `C:/Users/me/Favorites/${name}`, branch: "x" }).port,
    )
    expect(new Set(ports).size).toBe(ports.length)
    for (const port of ports) {
      expect(port).toBeGreaterThanOrEqual(TEST_APP_PORT_BASE)
      expect(port).toBeLessThan(TEST_APP_PORT_BASE + TEST_APP_PORT_SPAN)
      // Never ADE's own dev port, which is where the wrong code was served from.
      expect(port).not.toBe(5177)
    }
  })

  test("state lives in the worktree, labelled with name and branch", () => {
    const plan = planTestApp({ root: "C:/Users/me/Favorites/nikcli-ade-testapp", branch: "ade/test-app" })
    expect(plan.name).toBe("nikcli-ade-testapp")
    expect(plan.label).toBe("nikcli-ade-testapp · ade/test-app")
    expect(plan.profileDir.replace(/\\/g, "/")).toBe("C:/Users/me/Favorites/nikcli-ade-testapp/.ade-test/webview2")
  })

  test("the dev config points Vite and the window at the same port, strictly", () => {
    const config = JSON.parse(devConfig(5321))
    expect(config.build.devUrl).toBe("http://localhost:5321")
    expect(config.build.beforeDevCommand).toContain("--port 5321")
    expect(config.build.beforeDevCommand).toContain("--strictPort")
  })

  test("a record without a port or root is not trusted", () => {
    expect(parseRecord("{}")).toBeUndefined()
    expect(parseRecord("not json")).toBeUndefined()
    expect(parseRecord(JSON.stringify({ port: 5200, root: "C:/x", label: "x" }))?.port).toBe(5200)
  })

  describe("which processes are this worktree's instance", () => {
    const root = "C:\\Users\\me\\Favorites\\nikcli-ade-testapp"
    const other = "C:\\Users\\me\\Favorites\\nikcli-ade"
    const plan = planTestApp({ root, branch: "ade/test-app" })
    const otherPlan = planTestApp({ root: other, branch: "feat/ade" })
    const rows: ProcessRow[] = [
      { pid: 10, ppid: 1, cmd: `bun.exe x tauri dev --config src-tauri/tauri.test.conf.json --config ${plan.configPath}` },
      { pid: 11, ppid: 10, cmd: `node "${root}\\packages\\ade\\node_modules\\@tauri-apps\\cli\\tauri.js" dev` },
      { pid: 12, ppid: 11, cmd: "cargo run --no-default-features" },
      { pid: 13, ppid: 12, exe: `${root}\\packages\\ade\\src-tauri\\target\\debug\\ade-desktop.exe`, cmd: "target\\debug\\ade-desktop.exe" },
      { pid: 14, ppid: 13, cmd: `msedgewebview2.exe --user-data-dir="${plan.profileDir}\\EBWebView"` },
      // Orphaned: its parent shell is gone, but it is still this port's Vite.
      { pid: 15, ppid: 999, cmd: `node "${root}\\packages\\ade\\node_modules\\vite\\bin\\vite.js" --port 5270 --strictPort` },
      { pid: 16, ppid: 15, exe: `${root}\\node_modules\\esbuild.exe` },
      // Another worktree, whose path is a prefix of this one's.
      { pid: 20, ppid: 1, cmd: `bun.exe x tauri dev --config ${otherPlan.configPath}` },
      { pid: 21, ppid: 1, exe: `${other}\\packages\\ade\\src-tauri\\target\\debug\\ade-desktop.exe` },
      { pid: 22, ppid: 1, cmd: `node "${other}\\packages\\ade\\node_modules\\vite\\bin\\vite.js" --port 5270` },
      // The official app and an unrelated shell.
      { pid: 30, ppid: 1, exe: "C:\\Users\\me\\AppData\\Local\\ADE\\ade-desktop.exe" },
      { pid: 31, ppid: 1, cmd: "powershell.exe" },
    ]

    test("the whole tree, orphans included, and nothing of the other worktree", () => {
      const pids = instanceProcesses(rows, plan, root, 5270).map((row) => row.pid).sort((a, b) => a - b)
      expect(pids).toEqual([10, 11, 12, 13, 14, 15, 16])
      expect(instanceRunning(instanceProcesses(rows, plan, root, 5270), plan, root)).toBe(true)
    })

    test("a Vite or a WebView2 left alone does not count as running", () => {
      const leftovers = rows.filter((row) => row.pid === 14 || row.pid === 15)
      expect(instanceRunning(instanceProcesses(leftovers, plan, root, 5270), plan, root)).toBe(false)
    })
  })

  test("start failures are recognised in tauri dev output", () => {
    expect(startFailure("Error Port 5321 is already in use")).toContain("5321")
    expect(startFailure("Failed to setup app: error encountered during setup hook: Accesso negato. (os error 5)")).toContain(
      "Accesso negato",
    )
    expect(startFailure("     Running `target\\debug\\ade-desktop.exe`")).toBeUndefined()
  })

  test("hashPath is stable", () => {
    expect(hashPath("abc")).toBe(hashPath("ABC"))
  })
})
