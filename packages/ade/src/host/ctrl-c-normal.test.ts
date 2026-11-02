import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

/*
 * `test:app` starts `tauri dev` detached, and on Windows that sets «ignore Ctrl+C» on it and on everything below it:
 * Ctrl+C in a pane of ADE Test stopped nothing (live test of 2026-11-02, section F). The flag is read here where the
 * system keeps it, in the process's own parameters, by a program started exactly as `test:app` starts its child.
 */

const WRAPPER = join(import.meta.dir, "..", "..", "scripts", "ctrl-c-normal.ts")
const LAUNCHER = readFileSync(join(import.meta.dir, "..", "..", "scripts", "test-app.ts"), "utf8")

/** Prints bit 0 of RTL_USER_PROCESS_PARAMETERS.ConsoleFlags, of a process and of its child. */
const PROBE = `
import { dlopen, read } from "bun:ffi"
const ntdll = dlopen("ntdll.dll", { NtQueryInformationProcess: { args: ["ptr", "i32", "ptr", "u32", "ptr"], returns: "i32" } })
const info = new BigUint64Array(6)
ntdll.symbols.NtQueryInformationProcess(BigInt(-1), 0, info, 48, null)
const params = read.ptr(Number(info[1]), 0x20)
const flag = read.u32(params, 0x18) & 1
if (process.argv[2] === "child") console.log(flag)
else {
  const child = Bun.spawn([process.execPath, import.meta.path, "child"], { stdout: "pipe", stderr: "inherit", windowsHide: true })
  console.log(flag + " " + (await new Response(child.stdout).text()).trim())
}
`

function flagsOf(args: string[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "ctrl-c-"))
  const probe = join(dir, "probe.ts")
  writeFileSync(probe, PROBE)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...args, probe], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "inherit"],
    })
    let out = ""
    child.stdout.on("data", (data) => (out += String(data)))
    child.on("error", reject)
    child.on("close", () => {
      rmSync(dir, { recursive: true, force: true })
      resolve(out.trim())
    })
  })
}

describe("Ctrl+C under test:app", () => {
  test.skipIf(process.platform !== "win32")(
    "windows only (the flag does not exist elsewhere): a detached process ignores Ctrl+C, as does its child",
    async () => {
      expect(await flagsOf([])).toBe("1 1")
    },
    30_000,
  )

  test.skipIf(process.platform !== "win32")(
    "windows only (the flag does not exist elsewhere): through the wrapper, neither the command nor its child ignores it",
    async () => {
      expect(await flagsOf([WRAPPER])).toBe("0 0")
    },
    30_000,
  )

  test("lint: test:app starts tauri dev through the wrapper", () => {
    expect(LAUNCHER).toContain(`join(adeDir, "scripts", "ctrl-c-normal.ts")`)
  })
})
