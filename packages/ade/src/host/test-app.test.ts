import { describe, expect, test } from "bun:test"
import {
  TEST_APP_PORT_BASE,
  TEST_APP_PORT_SPAN,
  appStarted,
  devConfig,
  hashPath,
  instanceProcesses,
  instanceRunning,
  isAppProcess,
  killOrder,
  type ProcessRow,
  parseRecord,
  parseTestAppArgs,
  planTestApp,
  startFailure,
  stopInstance,
  tauriDevArgs,
} from "./test-app"

describe("host/test-app", () => {
  test("the same worktree gets the same port however its path is spelled", () => {
    const a = planTestApp({ root: "C:\\Users\\me\\Favorites\\ragu-ade", branch: "feat/ade" })
    const b = planTestApp({ root: "c:/users/me/favorites/ragu-ade/", branch: "feat/ade" })
    expect(a.port).toBe(b.port)
  })

  test("different worktrees get different ports, inside the reserved range", () => {
    const ports = ["ragu-ade", "ragu-ade-testapp", "ragu-ade-release", "ragu-ade-fix"].map(
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
    const plan = planTestApp({ root: "C:/Users/me/Favorites/ragu-ade-testapp", branch: "ade/test-app" })
    expect(plan.name).toBe("ragu-ade-testapp")
    expect(plan.label).toBe("ragu-ade-testapp · ade/test-app")
    // S25: its own ade-msg mailbox, not the one every test build shares.
    expect(plan.mailboxDir.replace(/\\/g, "/")).toBe("C:/Users/me/Favorites/ragu-ade-testapp/.ade-test/mailbox")
    expect(plan.profileDir.replace(/\\/g, "/")).toBe("C:/Users/me/Favorites/ragu-ade-testapp/.ade-test/webview2")
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
    const root = "C:\\Users\\me\\Favorites\\ragu-ade-testapp"
    const other = "C:\\Users\\me\\Favorites\\ragu-ade"
    const plan = planTestApp({ root, branch: "ade/test-app" })
    const otherPlan = planTestApp({ root: other, branch: "feat/ade" })
    const rows: ProcessRow[] = [
      {
        pid: 10,
        ppid: 1,
        cmd: `bun.exe x tauri dev --config src-tauri/tauri.test.conf.json --config ${plan.configPath}`,
      },
      { pid: 11, ppid: 10, cmd: `node "${root}\\packages\\ade\\node_modules\\@tauri-apps\\cli\\tauri.js" dev` },
      { pid: 12, ppid: 11, cmd: "cargo run --no-default-features" },
      {
        pid: 13,
        ppid: 12,
        exe: `${root}\\packages\\ade\\src-tauri\\target\\debug\\ade-desktop.exe`,
        cmd: "target\\debug\\ade-desktop.exe",
      },
      { pid: 14, ppid: 13, cmd: `msedgewebview2.exe --user-data-dir="${plan.profileDir}\\EBWebView"` },
      // Orphaned: its parent shell is gone, but it is still this port's Vite.
      {
        pid: 15,
        ppid: 999,
        cmd: `node "${root}\\packages\\ade\\node_modules\\vite\\bin\\vite.js" --port 5270 --strictPort`,
      },
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
      const pids = instanceProcesses(rows, plan, root, 5270)
        .map((row) => row.pid)
        .sort((a, b) => a - b)
      expect(pids).toEqual([10, 11, 12, 13, 14, 15, 16])
      expect(instanceRunning(instanceProcesses(rows, plan, root, 5270), plan, root)).toBe(true)
    })

    test("a Vite or a WebView2 left alone does not count as running", () => {
      const leftovers = rows.filter((row) => row.pid === 14 || row.pid === 15)
      expect(instanceRunning(instanceProcesses(leftovers, plan, root, 5270), plan, root)).toBe(false)
    })

    describe("with the start recorded, only what that start created", () => {
      const startedAt = 1_000_000
      const at = (row: ProcessRow, created: number | undefined): ProcessRow => ({ ...row, created })
      const timed = rows.map((row) => at(row, startedAt + row.pid))

      test("the instance it started, orphans included", () => {
        const pids = instanceProcesses(timed, plan, root, 5270, startedAt)
          .map((row) => row.pid)
          .sort((a, b) => a - b)
        expect(pids).toEqual([10, 11, 12, 13, 14, 15, 16])
      })

      test("a process naming the same paths but started before is someone else's, with its tree", () => {
        const earlier = timed.map((row) => (row.pid === 10 ? at(row, startedAt - 60_000) : row))
        // 11 and 12 hang below it and stay with it; 13 and 15 are roots of their own.
        const pids = instanceProcesses(earlier, plan, root, 5270, startedAt)
          .map((row) => row.pid)
          .sort((a, b) => a - b)
        expect(pids).toEqual([13, 14, 15, 16])
      })

      test("a child older than its parent reused a dead process's pid, and is not ours", () => {
        const reused: ProcessRow = { pid: 40, ppid: 12, cmd: "notepad.exe", created: startedAt - 3_600_000 }
        const pids = instanceProcesses([...timed, reused], plan, root, 5270, startedAt).map((row) => row.pid)
        expect(pids).not.toContain(40)
      })

      test("a process whose creation time is unknown is left alone", () => {
        const unknown = timed.map((row) => (row.pid === 15 ? at(row, undefined) : row))
        const pids = instanceProcesses(unknown, plan, root, 5270, startedAt).map((row) => row.pid)
        expect(pids).not.toContain(15)
        expect(pids).not.toContain(16)
      })

      test("children are killed before their parents, one by one", () => {
        const order = killOrder(instanceProcesses(timed, plan, root, 5270, startedAt)).map((row) => row.pid)
        expect(order.indexOf(14)).toBeLessThan(order.indexOf(13))
        expect(order.indexOf(13)).toBeLessThan(order.indexOf(12))
        expect(order.indexOf(11)).toBeLessThan(order.indexOf(10))
        expect(order.indexOf(16)).toBeLessThan(order.indexOf(15))
      })
    })
  })

  test("start failures are recognised in tauri dev output", () => {
    expect(startFailure("Error Port 5321 is already in use")).toContain("5321")
    expect(
      startFailure("Failed to setup app: error encountered during setup hook: Accesso negato. (os error 5)"),
    ).toContain("Accesso negato")
    expect(startFailure("     Running `target\\debug\\ade-desktop.exe`")).toBeUndefined()
  })

  test("a test build runs as ade-test only where Cargo.toml has the feature, and either name counts as started", () => {
    const before = '[[bin]]\nname = "ade-desktop"\n'
    const after = before + '[[bin]]\nname = "ade-test"\nrequired-features = ["test-exe"]\n\n[features]\ntest-exe = []\n'
    expect(tauriDevArgs("C:/w/.ade-test/tauri.dev.json", before)).not.toContain("--features")
    expect(tauriDevArgs("C:/w/.ade-test/tauri.dev.json", after).slice(-5)).toEqual([
      "--features",
      "test-exe",
      "--",
      "--bin",
      "ade-test",
    ])
    // The bin's own required-features line is not the feature's declaration.
    expect(tauriDevArgs("x", '[[bin]]\nrequired-features = ["test-exe"]\n')).not.toContain("--features")
    expect(appStarted("     Running `target\\debug\\ade-desktop.exe`")).toBe(true)
    expect(appStarted("     Running `target/debug/ade-test`")).toBe(true)
    expect(appStarted("   Compiling ade-desktop v0.0.0")).toBe(false)
  })

  test("a Rust change does not restart the window unless the start asked to watch", () => {
    const cargo = '[[bin]]\nname = "ade-test"\nrequired-features = ["test-exe"]\n\n[features]\ntest-exe = []\n'
    const quiet = tauriDevArgs("C:/w/.ade-test/tauri.dev.json", cargo)
    expect(quiet).toContain("--no-watch")
    // Past `--` the arguments are cargo's, so the flag has to come before it.
    expect(quiet.indexOf("--no-watch")).toBeLessThan(quiet.indexOf("--"))
    expect(quiet.slice(-5)).toEqual(["--features", "test-exe", "--", "--bin", "ade-test"])

    const watching = tauriDevArgs("C:/w/.ade-test/tauri.dev.json", cargo, { watch: true })
    expect(watching).not.toContain("--no-watch")
    expect(watching.slice(-5)).toEqual(["--features", "test-exe", "--", "--bin", "ade-test"])

    // The same, on a branch without the test binary: still no watching.
    expect(tauriDevArgs("x", '[[bin]]\nname = "ade-desktop"\n')).toContain("--no-watch")
  })

  test("hashPath is stable", () => {
    expect(hashPath("abc")).toBe(hashPath("ABC"))
  })
})

/*
 * Live test 2026-11-02: a launcher run with an absolute CARGO_TARGET_DIR never saw the window (the supervisor stopped
 * the instance at its timeout), and `test:app stop` killed instead of closing in order.
 */
describe("host/test-app with a build folder shared between worktrees", () => {
  const root = "C:\\Users\\me\\Favorites\\nikcli-ade-lavoro-3"
  const other = "C:\\Users\\me\\Favorites\\nikcli-ade-lavoro-1"
  const shared = "C:\\Users\\me\\Favorites\\.tmp-cargo\\prova-vivo"
  const env = { CARGO_TARGET_DIR: shared }
  const plan = planTestApp({ root, branch: "ade/prova-fix", env })
  const otherPlan = planTestApp({ root: other, branch: "x", env })
  const slashes = (text: string) => text.replace(/\\/g, "/")

  test("the plan says where cargo builds, and whether that is the worktree's own folder", () => {
    expect(plan.targetDir).toBe(shared)
    expect(plan.sharedTarget).toBe(true)
    const own = planTestApp({ root, branch: "x" })
    expect(slashes(own.targetDir)).toBe(`${slashes(root)}/packages/ade/src-tauri/target`)
    expect(own.sharedTarget).toBe(false)
    // A relative one is read from src-tauri, where `tauri dev` runs cargo; the worktree's own folder named that way is not shared.
    const relative = planTestApp({ root, branch: "x", env: { CARGO_TARGET_DIR: "target" } })
    expect(slashes(relative.targetDir)).toBe(`${slashes(root)}/packages/ade/src-tauri/target`)
    expect(relative.sharedTarget).toBe(false)
  })

  test("cargo's «Running» line is the app started, whatever path it prints", () => {
    expect(appStarted(`     Running \`${shared}\\debug\\ade-test.exe\``)).toBe(true)
    expect(appStarted("     Running `C:/Users/me/Favorites/.tmp-cargo/prova-vivo/debug/ade-test.exe`")).toBe(true)
    expect(appStarted("     Running `target\\debug\\ade-test.exe`")).toBe(true)
    expect(appStarted("     Running `target\\x86_64-pc-windows-msvc\\debug\\ade-desktop.exe`")).toBe(true)
    expect(appStarted("   Compiling ade-desktop v0.0.0 (C:\\w\\src-tauri)")).toBe(false)
    // Not another binary of the build folder.
    expect(appStarted(`     Running \`${shared}\\debug\\build\\ade-desktop-abc\\build-script-build.exe\``)).toBe(false)
  })

  const app = `${shared}\\debug\\ade-test.exe`
  const rows: ProcessRow[] = [
    { pid: 10, ppid: 1, cmd: `bun.exe x tauri dev --config src-tauri/tauri.test.conf.json --config ${plan.configPath}` },
    { pid: 11, ppid: 10, cmd: "cargo run" },
    { pid: 13, ppid: 11, exe: app, cmd: app },
    { pid: 14, ppid: 13, cmd: `msedgewebview2.exe --user-data-dir="${plan.profileDir}\\EBWebView"` },
    // Another worktree's instance, built into the same folder: the same binary path.
    { pid: 20, ppid: 1, cmd: `bun.exe x tauri dev --config ${otherPlan.configPath}` },
    { pid: 23, ppid: 20, exe: app, cmd: app },
    { pid: 24, ppid: 23, cmd: `msedgewebview2.exe --user-data-dir="${otherPlan.profileDir}\\EBWebView"` },
  ]

  test("this instance's app is found, and the other worktree's app with the same binary is not", () => {
    const pids = instanceProcesses(rows, plan, root)
      .map((row) => row.pid)
      .sort((a, b) => a - b)
    expect(pids).toEqual([10, 11, 13, 14])
    expect(instanceRunning(instanceProcesses(rows, plan, root), plan, root)).toBe(true)
  })

  test("with `tauri dev` gone the app is still found, as the parent of this worktree's WebView2", () => {
    const orphaned = rows.filter((row) => row.pid !== 10 && row.pid !== 11)
    const pids = instanceProcesses(orphaned, plan, root)
      .map((row) => row.pid)
      .sort((a, b) => a - b)
    expect(pids).toEqual([13, 14])
  })

  test("a binary in the shared folder that is nobody's here does not make the instance run", () => {
    const stray = rows.filter((row) => row.pid === 23)
    expect(instanceProcesses(stray, plan, root)).toEqual([])
  })

  test("stop closes the app in order, then kills the rest, and leaves the other worktree's app alone", () => {
    const startedAt = 1_000_000
    const timed = rows.map((row) => ({ ...row, created: startedAt + row.pid }))
    const closed: number[] = []
    const killed: number[] = []
    const result = stopInstance({
      rows: timed,
      record: { port: 5270, label: "x", root, startedAt },
      plan,
      root,
      selfPid: 999,
      kill: (pid) => void killed.push(pid),
      removeRecord: () => {},
      close: (pid) => void closed.push(pid),
      waitExit: () => [],
      reread: () => timed.filter((row) => row.pid !== 13 && row.pid !== 14),
    })
    expect(closed).toEqual([13])
    expect(killed).not.toContain(23)
    expect(killed).not.toContain(24)
    expect(killed).not.toContain(13)
    expect(killed.sort((a, b) => a - b)).toEqual([10, 11])
    expect(result.outcome).toBe("stopped")
  })

  test("isAppProcess knows the shared folder", () => {
    expect(isAppProcess({ pid: 1, ppid: 0, exe: app }, root, shared)).toBe(true)
    expect(isAppProcess({ pid: 1, ppid: 0, exe: app }, root)).toBe(false)
  })
})

describe("host/test-app arguments", () => {
  test("the command is the first word that is not a flag, and --jobs takes its number", () => {
    expect(parseTestAppArgs([])).toEqual({ command: "start", cdp: false, watch: false, low: false, firstRun: [] })
    expect(parseTestAppArgs(["--cdp", "--low", "--jobs", "2"])).toEqual({
      command: "start",
      cdp: true,
      watch: false,
      low: true,
      jobs: 2,
      firstRun: [],
    })
    expect(parseTestAppArgs(["stop"]).command).toBe("stop")
    expect(parseTestAppArgs(["--jobs=3", "status"])).toMatchObject({ command: "status", jobs: 3 })
  })

  test("a bad --jobs is an error, not a command", () => {
    for (const bad of [["--jobs"], ["--jobs", "x"], ["--jobs", "0"], ["--jobs", "99"], ["--jobs="]]) {
      const parsed = parseTestAppArgs(bad)
      expect(parsed.error).toContain("--jobs")
      expect(parsed.jobs).toBeUndefined()
    }
  })
})
