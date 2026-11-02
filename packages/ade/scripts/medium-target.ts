/**
 * Labels `src-tauri/target` Medium when it inherited Low. See `src/host/integrity.ts`.
 *
 * Run before `tauri dev`: once the folder carries its own inheritable Medium
 * label, every binary cargo writes there starts at Medium, so the check costs
 * one `icacls` call and does nothing on a machine without the problem. Only
 * Windows has integrity labels.
 *
 * The folder's label only reaches what is written after it. An executable already in `target/debug` or `target/debug/build`
 * (`ade-test.exe`, a build script) that an earlier cargo left Low keeps its label when the folder is Medium: it is looked for
 * on its own, and `target/debug` is labelled again when one is found.
 */

import { existsSync, mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { hasLowLabel, lowLabeledExecutables } from "../src/host/integrity"

const relabel = (folder: string) =>
  Bun.spawnSync(["icacls", folder, "/setintegritylevel", "(OI)(CI)Medium", "/T", "/C", "/Q"], {
    stdout: "inherit",
    stderr: "inherit",
  })

const warn = () =>
  console.warn("ADE: non sono riuscito a cambiare l'etichetta; ragu e gli altri agenti potrebbero non scrivere i loro file.")

if (process.platform === "win32") {
  // The build folder cargo will write to: the shared one when the launcher names it (review N7), else this worktree's own.
  const chosen = process.env.CARGO_TARGET_DIR?.trim()
  const target = chosen
    ? resolve(join(import.meta.dir, "..", "src-tauri"), chosen)
    : join(import.meta.dir, "..", "src-tauri", "target")
  mkdirSync(target, { recursive: true })
  const read = Bun.spawnSync(["icacls", target])
  if (hasLowLabel(read.stdout.toString())) {
    console.log("ADE: la cartella di build ha l'etichetta di integrità Low, la porto a Medium…")
    // `/T`: everything already inside, executables included.
    if (relabel(target).exitCode !== 0) warn()
  } else {
    const debug = join(target, "debug")
    if (existsSync(debug)) {
      // The executables of `debug` itself, and those of the build scripts under `debug/build`.
      const listed = [
        Bun.spawnSync(["icacls", join(debug, "*.exe"), "/C"]),
        ...(existsSync(join(debug, "build")) ? [Bun.spawnSync(["icacls", join(debug, "build"), "/T", "/C"])] : []),
      ]
      const low = listed.flatMap((result) => lowLabeledExecutables(result.stdout.toString()))
      if (low.length > 0) {
        console.log(`ADE: ${low.length} eseguibili in debug hanno l'etichetta Low, li porto a Medium…`)
        if (relabel(debug).exitCode !== 0) warn()
      }
    }
  }
}
