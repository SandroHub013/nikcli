import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/*
 * Brief ragu-via-servizi-nik, package C: when the npm package could not find its native binary, the launcher and the
 * postinstall sent the user to nikcli-ai.dev/install; the package README installed from there and linked Nik's docs;
 * the package's agent notes and the account-guard script named s.nikcli-ai.dev as the sync and share hub. They now
 * point to the repository's install scripts, or name no host.
 */
const PKG = path.join(import.meta.dir, "../..")
const read = (file: string) => fs.readFileSync(path.join(PKG, file), "utf8")
const NIK = /nikcli-ai\.dev|nikcli\.store/

describe("the ragu package without Nik's site", () => {
  test("a missing native binary points to the repository's install scripts", () => {
    for (const file of ["bin/ragu", "script/postinstall.mjs"]) {
      expect(read(file)).not.toMatch(NIK)
      expect(read(file)).toContain("install.ps1")
    }
  })

  test("the package README and notes name no Nik host", () => {
    for (const file of [
      "README.md",
      ".github/instructions/memory.instruction.md",
      "script/check-account-required.ts",
    ]) {
      expect(read(file)).not.toMatch(NIK)
    }
  })
})
