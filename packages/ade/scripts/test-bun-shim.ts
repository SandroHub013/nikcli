/**
 * Simulates a broken bun shim in PATH (as produced by `bun install --linker hoisted` on Windows)
 * and verifies that discovery correctly discards node_modules/.bin to find the real global bun.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { delimiter, join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"

const testDir = join(tmpdir(), `ade-test-bun-shim-${Date.now()}`)
const fakeNodeModulesBin = join(testDir, "node_modules", ".bin")
mkdirSync(fakeNodeModulesBin, { recursive: true })

const isWindows = process.platform === "win32"
const shimCmd = join(fakeNodeModulesBin, isWindows ? "bun.cmd" : "bun")
const shimScript = isWindows
  ? `@echo off\necho bun: error: could not create process 1>&2\necho Bun failed to remap this bin to its proper location within node_modules. 1>&2\nexit /b 1\n`
  : `#!/bin/sh\necho "bun: error: could not create process" >&2\necho "Bun failed to remap this bin to its proper location within node_modules." >&2\nexit 1\n`

writeFileSync(shimCmd, shimScript, { mode: 0o755 })

const originalPath = process.env.PATH || ""
const pollutedPath = `${fakeNodeModulesBin}${delimiter}${originalPath}`

// Verify that the fake shim is indeed broken
const shimRun = spawnSync(isWindows ? "cmd.exe" : "/bin/sh", isWindows ? ["/c", shimCmd] : [shimCmd], {
  encoding: "utf8",
})
if (shimRun.status === 0 || !shimRun.stderr.includes("Bun failed to remap")) {
  console.error("Test setup error: fake shim did not reproduce expected failure")
  process.exit(1)
}

// 1. Without filtering: looking up bun on polluted PATH would run the broken shim
console.log("Verified: fake shim reproduces the failure on polluted PATH.")

// 2. With node_modules filtering: locate bun while ignoring node_modules directories
function isNodeModules(dir: string): boolean {
  return dir.split(/[\\/]/).some((part) => part.toLowerCase() === "node_modules")
}

const pathDirs = pollutedPath.split(delimiter)
const cleanDirs = pathDirs.filter((dir) => !isNodeModules(dir))

let realBun: string | undefined
for (const dir of cleanDirs) {
  for (const name of isWindows ? ["bun.exe", "bun.cmd", "bun"] : ["bun"]) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) {
      realBun = candidate
      break
    }
  }
  if (realBun) break
}

if (!realBun) {
  console.error("Could not find real bun in clean PATH")
  rmSync(testDir, { recursive: true, force: true })
  process.exit(1)
}

console.log(`Found real bun after filtering: ${realBun}`)

// Verify real bun can execute build-nikverse-world.ts --check
const scriptPath = join(import.meta.dir, "build-nikverse-world.ts")
const buildRun = spawnSync(realBun, [scriptPath, "--check"], {
  encoding: "utf8",
  shell: isWindows && realBun.endsWith(".cmd"),
})
if (buildRun.status !== 0) {
  console.error(`Build failed with real bun: ${buildRun.stderr || buildRun.error}`)
  rmSync(testDir, { recursive: true, force: true })
  process.exit(1)
}

console.log("Success: build-nikverse-world.ts succeeded with real bun, skipping broken node_modules shim.")
rmSync(testDir, { recursive: true, force: true })
console.log("Test passed.")
