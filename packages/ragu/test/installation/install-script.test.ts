import { describe, expect, it } from "bun:test"
import fs from "fs/promises"
import path from "path"

/*
 * The install scripts in the repository. Ragu Code no longer runs them to update itself (see
 * test/via-nik/autoupdate.test.ts); these checks only keep the served copies consistent.
 */
const root = path.resolve(import.meta.dir, "../../../..")
const readSrc = (rel: string) => fs.readFile(path.join(root, rel), "utf8")

describe("deferred Windows swap (install.ps1)", () => {
  it("stays in sync across all served copies of the installer", async () => {
    const [root_, web, publicCopy] = await Promise.all([
      readSrc("install.ps1"),
      readSrc("packages/web/install.ps1"),
      readSrc("packages/web/public/install.ps1"),
    ])
    expect(web).toBe(root_)
    expect(publicCopy).toBe(root_)
  })

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
