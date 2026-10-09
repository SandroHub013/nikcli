import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/*
 * Brief ragu-via-servizi-nik, package C (Master, after the first round): the installers downloaded Nik's binaries
 * from github.com/nikcli/nikcli. They download from the fork's releases now, named in one constant per script so the
 * move to the new repository is a one-line change.
 */
const ROOT = path.join(import.meta.dir, "../../../..")
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8")

describe("the installers download from the fork", () => {
  test("install names the repository once and uses it for every GitHub URL", () => {
    const sh = read("install")
    expect(sh).toContain('REPO="SandroHub013/nikcli"')
    expect(sh.match(/SandroHub013\/nikcli/g)).toHaveLength(1)
    expect(sh).not.toContain("nikcli/nikcli")
    expect(sh).toContain("https://github.com/${REPO}/releases/download/${release_tag}")
    expect(sh).toContain("https://api.github.com/repos/${REPO}/releases/latest")
  })

  test("install.ps1 names the repository once", () => {
    const ps1 = read("install.ps1")
    expect(ps1).toContain('$Repo = "SandroHub013/nikcli"')
    expect(ps1.match(/SandroHub013\/nikcli/g)).toHaveLength(1)
    expect(ps1).not.toContain("nikcli/nikcli")
  })
})
