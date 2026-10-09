import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/*
 * Brief ragu-via-servizi-nik, package C: the README installed from nikcli-ai.dev, pointed to Nik's docs, config schema,
 * web app and Slack bot, and described the share hosts that are gone; the GitHub Action README, the Homebrew tap and the
 * nix package used nikcli-ai.dev as homepage; the sync guide used s.nikcli-ai.dev as the example hub; the agents'
 * memory notes and the ragu skill linked Nik's docs. They now point to the repository, or say nothing.
 */
const ROOT = path.join(import.meta.dir, "../../../..")
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8")
const NIK = /nikcli-ai\.dev|nikcli\.store/

const DOCS = [
  "README.md",
  "github/README.md",
  "homebrew-tap/README.md",
  "homebrew-tap/Formula/nikcli.rb",
  "nix/ragu.nix",
  "docs/sync-architecture.md",
  ".github/instructions/memory.instruction.md",
  ".nikcli/skill/ragu-skill/SKILL.md",
]

describe("the repository's docs without Nik's site", () => {
  for (const file of DOCS) {
    test(file, () => {
      expect(read(file)).not.toMatch(NIK)
    })
  }

  test("the README installs from the repository's scripts", () => {
    const readme = read("README.md")
    expect(readme).toContain("./install")
    expect(readme).toContain(".\\install.ps1")
  })
})
