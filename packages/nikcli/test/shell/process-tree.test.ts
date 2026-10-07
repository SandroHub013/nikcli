import { describe, expect, it } from "bun:test"
import { spawn, spawnSync, type ChildProcess } from "child_process"
import path from "path"
import { dlopen, FFIType } from "bun:ffi"
import { Shell } from "@/shell/shell"

/**
 * On Windows `Shell.killTree` was `taskkill /pid <shell> /f /t`, which follows the chain of parent PIDs. A process whose parent has
 * already exited is not on that chain: it outlived a command stopped by its timeout (two `find.exe` held 8.5 GB of handles for 7.5
 * hours). `Shell.adopt` puts the command in a Job Object, and stopping the command ends everything that ever ran in it.
 *
 * The orphan is made without any msys program: a middle `cmd` starts a long `ping` and exits at once, so the ping's parent is gone while
 * the root command is still running. Every test finds what it started by a marker in the command line and kills it by PID in `finally`,
 * so a failing test does not leave the orphan it is looking for.
 */
const windows = process.platform === "win32"

/**
 * Whether this process already runs inside a Job Object (a sandbox, a terminal, a CI agent). There, a process put in a nested job was
 * measured to die when the process that spawned it exits, even with the kill-on-close flag cleared and the handle left open: so "the
 * leftover outlives nikcli" cannot be shown, and is skipped.
 */
const insideAJob = (() => {
  if (!windows) return false
  try {
    const k = dlopen("kernel32.dll", {
      IsProcessInJob: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      GetCurrentProcess: { args: [], returns: FFIType.ptr },
    })
    const result = new Uint8Array(4)
    return k.symbols.IsProcessInJob(k.symbols.GetCurrentProcess(), null, result) !== 0 && result[0] !== 0
  } catch {
    return false
  }
})()

const marker = () => `127.${Math.floor(Math.random() * 200) + 20}.${Math.floor(Math.random() * 200) + 20}.${Math.floor(Math.random() * 200) + 20}`

function pidsWith(address: string): number[] {
  const query = `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'PING.EXE' -and $_.CommandLine -like '*${address}*' } | ForEach-Object { $_.ProcessId }`
  const out = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", query], { encoding: "utf8", timeout: 20_000 })
  return (out.stdout ?? "")
    .split(/\s+/)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}

function killByPid(pids: number[]) {
  for (const pid of pids) spawnSync("taskkill", ["/pid", String(pid), "/f"], { stdio: "ignore", timeout: 10_000 })
}

/** A root `cmd` that stays alive (a long ping) after a middle `cmd` has started an orphan ping and exited. */
function startCommand(address: string, adopt: boolean): { proc: ChildProcess; exited: () => boolean } {
  const script = `cmd /c "start /b ping -n 600 ${address} > nul" & ping -n 600 127.0.0.1 > nul`
  const proc = spawn(script, { shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  let exited = false
  proc.once("exit", () => (exited = true))
  if (adopt) Shell.adopt(proc)
  return { proc, exited: () => exited }
}

async function waitForPing(address: string) {
  for (let waited = 0; waited < 15_000 && pidsWith(address).length === 0; waited += 500) await Bun.sleep(500)
}

describe.skipIf(!windows)("Shell.killTree on Windows", () => {
  it("premise: without a job, taskkill /t misses a process whose parent has exited", async () => {
    const address = marker()
    const { proc, exited } = startCommand(address, false)
    try {
      await waitForPing(address)
      expect(pidsWith(address).length).toBeGreaterThan(0)
      await Shell.killTree(proc, { exited })
      await Bun.sleep(500)
      expect(pidsWith(address).length).toBeGreaterThan(0)
    } finally {
      killByPid(pidsWith(address))
      proc.kill()
    }
  }, 60_000)

  it("a command in a job leaves no orphan when it is stopped", async () => {
    const address = marker()
    const { proc, exited } = startCommand(address, true)
    try {
      await waitForPing(address)
      expect(pidsWith(address).length).toBeGreaterThan(0)
      await Shell.killTree(proc, { exited })
      await Bun.sleep(500)
      expect(pidsWith(address)).toEqual([])
    } finally {
      killByPid(pidsWith(address))
      proc.kill()
    }
  }, 60_000)

  it("what a command leaves running after it ends by itself stays: `start chrome`, `code .`, a server started with &", async () => {
    const address = marker()
    const script = `cmd /c "start /b ping -n 600 ${address} > nul"`
    const proc = spawn(script, { shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let exited = false
    proc.once("exit", () => (exited = true))
    Shell.adopt(proc)
    try {
      await waitForPing(address)
      for (let waited = 0; waited < 10_000 && !exited; waited += 100) await Bun.sleep(100)
      expect(exited).toBe(true)
      await Bun.sleep(500)
      // The job has let go: nothing ends the leftover, neither the end of the command nor a later stop.
      expect(Shell.openJobs()).toBe(0)
      await Shell.killTree(proc, { exited: () => exited })
      await Bun.sleep(500)
      expect(pidsWith(address).length).toBeGreaterThan(0)
    } finally {
      killByPid(pidsWith(address))
    }
  }, 60_000)

  it("a command that ends by itself and leaves nothing behind frees its job", async () => {
    const proc = spawn("cmd /c echo done", { shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    Shell.adopt(proc)
    await new Promise((resolve) => proc.once("exit", resolve))
    await Bun.sleep(600)
    expect(Shell.openJobs()).toBe(0)
  }, 30_000)
})

/**
 * nikcli killed from outside (`taskkill /f`, a crash): nothing runs its cleanup, so the only thing left to end the command's processes is
 * the job handle closing with the process (`KILL_ON_JOB_CLOSE`), for a command that is still running. The host is a small stand-in for nikcli that does what the tool bash and
 * the monitor do.
 */
describe.skipIf(!windows)("a command in a job and the life of nikcli", () => {
  const host = path.join(import.meta.dir, "fixtures", "host-command.ts")

  async function startHost(address: string, mode: "long" | "background") {
    const child = spawn(process.execPath, [host, address, mode], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    child.stdout?.on("data", (chunk) => (out += String(chunk)))
    for (let waited = 0; waited < 20_000 && !out.includes("started"); waited += 100) await Bun.sleep(100)
    expect(out).toContain("started")
    return { child, output: () => out }
  }

  const endHost = (child: ChildProcess) =>
    child.pid && spawnSync("taskkill", ["/pid", String(child.pid), "/f"], { stdio: "ignore", timeout: 10_000 })

  it("a command still running when nikcli is killed with taskkill /f leaves no process behind", async () => {
    const address = marker()
    const { child } = await startHost(address, "long")
    try {
      await waitForPing(address)
      expect(pidsWith(address).length).toBeGreaterThan(0)
      endHost(child)
      await Bun.sleep(1_500)
      expect(pidsWith(address)).toEqual([])
    } finally {
      killByPid(pidsWith(address))
      endHost(child)
    }
  }, 60_000)

  it.skipIf(insideAJob)("a process left in the background survives the end of its command and the death of nikcli", async () => {
    const address = marker()
    const { child, output } = await startHost(address, "background")
    try {
      await waitForPing(address)
      for (let waited = 0; waited < 10_000 && !output().includes("command-exited"); waited += 100) await Bun.sleep(100)
      expect(output()).toContain("command-exited")
      // The command ended normally: its background process is still there, as it has always been.
      await Bun.sleep(1_000)
      expect(pidsWith(address).length).toBeGreaterThan(0)
      endHost(child)
      await Bun.sleep(1_500)
      // Nikcli is gone and the process stays, like on Linux (it was meant to outlive the command).
      expect(pidsWith(address).length).toBeGreaterThan(0)
    } finally {
      killByPid(pidsWith(address))
      endHost(child)
    }
  }, 60_000)
})

describe.skipIf(windows)("Shell.adopt off Windows", () => {
  it("does nothing: the process group is what killTree uses", () => {
    const proc = spawn("sleep 0", { shell: true, stdio: "ignore" })
    expect(() => Shell.adopt(proc)).not.toThrow()
    expect(Shell.openJobs()).toBe(0)
  })
})
