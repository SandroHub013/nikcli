import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { spawnSync } from "child_process"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { BashTool } from "@/tool/bash"
import { Shell } from "@/shell/shell"
import { Instance } from "@/project/instance"
import { removeTestDir } from "../helpers/fs"
import { makeToolContext, withProjectDirectory } from "../helpers/tool-context"

/**
 * On Windows `taskkill /t` follows the chain of parent PIDs, so a grandchild whose parent is gone, or one the shell started in the
 * background, outlived a command stopped by its timeout (two `find.exe` held 8.5 GB of handles for 7.5 hours). A Job Object per command
 * kills the whole tree. Every test finds what it started by a marker in the command line and, in `finally`, kills it by PID: a failing
 * test must not leave the orphan it is looking for.
 */
const windows = process.platform === "win32"

/**
 * Whether the shell the tool picks can start from this process at all. Under a restricted sandbox Git Bash dies at start-up
 * (`NtCreateDirectoryObject ... 0xC0000022`) when its parent is Bun, and then no BashTool test can run: they are skipped there.
 */
const shellRuns = windows && spawnSync(Shell.acceptable(), ["-c", "true"], { timeout: 20_000 }).status === 0

function pidsWith(marker: string): number[] {
  const query = `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'sleep.exe' -and $_.CommandLine -like '*${marker}*' } | ForEach-Object { $_.ProcessId }`
  const out = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", query], {
    encoding: "utf8",
    timeout: 20_000,
  })
  return (out.stdout ?? "")
    .split(/\s+/)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}

function killByPid(pids: number[]) {
  for (const pid of pids) spawnSync("taskkill", ["/pid", String(pid), "/f"], { stdio: "ignore", timeout: 10_000 })
}

describe.skipIf(!shellRuns)("BashTool on Windows: a stopped command leaves no process behind", () => {
  let projectDir: string
  let def: Awaited<ReturnType<typeof BashTool.init>>

  beforeAll(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragu-bash-tree-"))
    await fs.mkdir(path.join(projectDir, ".git"), { recursive: true })
    def = await withProjectDirectory(projectDir, () => BashTool.init())
  })

  afterAll(async () => {
    await Instance.disposeAll().catch(() => undefined)
    await removeTestDir(projectDir)
  })

  const run = async (command: string, timeout: number) => {
    const { ctx } = makeToolContext()
    return withProjectDirectory(projectDir, () => def.executeAsync({ command, timeout, description: "tree" }, ctx))
  }

  // `sleep N; echo` keeps bash from exec-ing the sleep: the sleep is a grandchild of the tool.
  it("a timeout kills the grandchild of a foreground command", async () => {
    const marker = `600.${Date.now() % 100000}1`
    try {
      const result = await run(`sleep ${marker}; echo fine`, 2_500)
      expect(result.output).toContain("timeout")
      await Bun.sleep(500)
      expect(pidsWith(marker)).toEqual([])
    } finally {
      killByPid(pidsWith(marker))
    }
  }, 60_000)

  it("a timeout kills a background process the shell waits on", async () => {
    const marker = `600.${Date.now() % 100000}2`
    try {
      const result = await run(`sleep ${marker} & wait`, 2_500)
      expect(result.output).toContain("timeout")
      await Bun.sleep(500)
      expect(pidsWith(marker)).toEqual([])
    } finally {
      killByPid(pidsWith(marker))
    }
  }, 60_000)

  it("an abort kills the tree too", async () => {
    const marker = `600.${Date.now() % 100000}3`
    const controller = new AbortController()
    const { ctx } = makeToolContext()
    ctx.abort = controller.signal
    try {
      const running = withProjectDirectory(projectDir, () =>
        def.executeAsync({ command: `sleep ${marker}; echo fine`, timeout: 120_000, description: "tree" }, ctx),
      )
      // Let the sleep start before stopping the command.
      for (let waited = 0; waited < 15_000 && pidsWith(marker).length === 0; waited += 500) await Bun.sleep(500)
      expect(pidsWith(marker).length).toBeGreaterThan(0)
      controller.abort()
      const result = await running
      expect(result.output).toContain("aborted")
      await Bun.sleep(500)
      expect(pidsWith(marker)).toEqual([])
    } finally {
      killByPid(pidsWith(marker))
    }
  }, 90_000)
})
