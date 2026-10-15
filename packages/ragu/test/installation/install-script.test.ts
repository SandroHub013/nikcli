import { describe, expect, it } from "bun:test"
import fs from "fs/promises"
import path from "path"

/*
 * The install scripts in the repository. Ragu Code no longer runs them to update itself (see
 * test/via-nik/autoupdate.test.ts); these checks keep the Windows installer's swap safe.
 */
const root = path.resolve(import.meta.dir, "../../../..")
const readSrc = (rel: string) => fs.readFile(path.join(root, rel), "utf8")

describe("deferred Windows swap (install.ps1)", () => {
  it("retries long enough to move a large binary and falls back to rename-aside", async () => {
    const ps1 = await readSrc("install.ps1")
    // 100 x 100ms (~10s) was not enough to move a ~160MB exe on a slow disk.
    expect(ps1).not.toContain("`$attempt -lt 100;")
    expect(ps1).toContain("`$attempt -lt 480;")
    // Windows allows renaming a running exe even though it refuses to
    // overwrite it, so a relaunched ragu no longer blocks the swap.
    expect(ps1).toContain("'.old.' + [System.Guid]::NewGuid().ToString('N')")
  })

  it("keeps the staged binary and logs the reason when the swap fails", async () => {
    const ps1 = await readSrc("install.ps1")
    // The old helper deleted the staged update and exited 1 in silence.
    expect(ps1).not.toMatch(/Remove-Item -LiteralPath '\$quotedPending' -Force[\s\S]{0,20}exit 1/)
    expect(ps1).toContain("$App.update.log")
    expect(ps1).toContain("Previous deferred update failed")
  })

  it("sweeps the renamed-aside binaries it leaves behind", async () => {
    const ps1 = await readSrc("install.ps1")
    expect(ps1).toContain('-Filter "$App.exe.old.*"')
  })

  it("applies a staged ragu.update.*.exe on the next install run when the upgrade PID is gone", async () => {
    const ps1 = await readSrc("install.ps1")
    // The installation flow stages a new binary beside the running one when
    // the in-place copy is locked. The detached helper that should swap it
    // in runs after the installer exits, so if the user re-runs the
    // installer (or another `ragu upgrade`) before the helper has had a
    // chance, the staged file must be applied instead of re-downloaded.
    expect(ps1).toContain("Applied staged update from")
    // The heuristic is the upgrade PID: if $env:NIKCLI_UPGRADE_PID points to
    // a still-running ragu.exe, leave the staged file alone for the helper.
    expect(ps1).toContain("if ($env:NIKCLI_UPGRADE_PID)")
    expect(ps1).toContain("Get-Process -Id $staleUpgrader")
  })

  it("probes the swapped binary to confirm the version actually changed", async () => {
    const ps1 = await readSrc("install.ps1")
    // After a successful swap (loop or rename-aside fallback), the helper
    // probes the new binary's --version and writes a log line if it does
    // not match the expected version. Without this, a corrupted file or a
    // wrong target download would go unnoticed.
    expect(ps1).toContain("`$installed = (& '$quotedTarget' --version 2>`$null | Select-Object -First 1)")
    expect(ps1).toContain("probe reports '")
  })

  it("interpolates the expected version into the helper so the probe works on PS 5.1", async () => {
    const ps1 = await readSrc("install.ps1")
    // `Start-Process -Environment` was added in PowerShell 7, but Windows
    // Server 2022 and Windows 10 hosts still ship PowerShell 5.1 by default.
    // The expected version is therefore baked into the helper script at
    // build time via a quoted interpolation, instead of being passed via
    // -Environment / $env:RAGU_VERSION.
    expect(ps1).toContain("$quotedVersion = $version.Replace(")
    expect(ps1).not.toContain("-Environment @{ NIKCLI_VERSION = $env:NIKCLI_VERSION }")
  })
})

/*
 * The user, 2026-10-16 (ragu-brand, point 5): the installer's pixel logo in the
 * home's colours, «ragu» tomato and «code» basil.
 */
describe("the wordmark (install)", () => {
  const ROWS = [
    "                                     ▄",
    "    █▀▀▀ ▀▀▀█ █▀▀█ █  █ █▀▀▀ █▀▀█ █▀▀█ █▀▀█",
    "    █    █▀▀█ █  █ █  █ █    █  █ █  █ █▀▀▀",
    "    ▀    ▀▀▀▀ ▀▀▀█ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀",
    "              ▀▀▀▀",
  ]
  const channel = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  const luminance = ([r, g, b]: number[]) =>
    0.2126 * channel(r! / 255) + 0.7152 * channel(g! / 255) + 0.0722 * channel(b! / 255)
  const ratio = (a: number[], b: number[]) => {
    const [x, y] = [luminance(a), luminance(b)]
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
  }

  async function logo() {
    const sh = await readSrc("install")
    const body = sh.match(/\nlogo\(\) \{\n([\s\S]*?)\n\}\n/)![1]!
    return body
      .split("\n")
      .map((line) => line.match(/^\s*ui "(.*)"$/)?.[1])
      .filter((line) => line !== undefined && line !== "")
  }

  it("draws the same letters, «ragu» in TOMATO and «code» in BASIL", async () => {
    const rows = await logo()
    expect(rows.map((row) => row!.replace(/\$\{\w+\}/g, ""))).toEqual(ROWS)
    for (const row of rows) {
      let colour = ""
      let column = 0
      for (const part of row!.split(/(\$\{\w+\})/)) {
        const variable = part.match(/^\$\{(\w+)\}$/)?.[1]
        if (variable) {
          colour = variable
          continue
        }
        for (const char of part) {
          // Four columns of indent, then «ragu» in 19 and «code» after one of gap.
          if (char.trim() !== "") expect(colour).toBe(column < 4 + 19 ? "TOMATO" : "BASIL")
          column++
        }
      }
    }
  })

  it("picks colours that read on a black and on a white terminal alike, in truecolor and in 256 colours", async () => {
    const sh = await readSrc("install")
    const truecolor = (name: string) =>
      sh
        .match(new RegExp(String.raw`${name}='\\033\[38;2;(\d+);(\d+);(\d+)m'`))!
        .slice(1)
        .map(Number)
    /** The HSL hue, in degrees. */
    const hueOf = ([r, g, b]: number[]) => {
      const [max, min] = [Math.max(r!, g!, b!), Math.min(r!, g!, b!)]
      const d = max - min
      const h = max === r ? ((g! - b!) / d) % 6 : max === g ? (b! - r!) / d + 2 : (r! - g!) / d + 4
      return (h * 60 + 360) % 360
    }
    for (const [name, brand] of [
      ["TOMATO", [0xdf, 0x4a, 0x2b]],
      ["BASIL", [0x4f, 0x8a, 0x2e]],
    ] as const) {
      const rgb = truecolor(name)
      expect(ratio(rgb, [0, 0, 0])).toBeGreaterThanOrEqual(4.5)
      expect(ratio(rgb, [255, 255, 255])).toBeGreaterThanOrEqual(4.5)
      // The brand's colour, only darker.
      expect(Math.abs(hueOf(rgb) - hueOf([...brand]))).toBeLessThan(3)
      expect(sh).toMatch(new RegExp(String.raw`${name}='\\033\[38;5;\d+m'`))
    }
    expect(sh).toContain('case "${COLORTERM:-}" in')
  })
})
