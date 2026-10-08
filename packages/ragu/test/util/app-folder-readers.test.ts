import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/**
 * Rule B (`@ragu/util/app-folder`): a user's folders and config files are `ragu` if they exist, else `nikcli`.
 * A reader that names the old folder or file itself skips the rule, and a guard that does protects one of the
 * two names only; so no code names them but the places listed here, each with its reason.
 */
const ROOT = path.join(import.meta.dir, "../../..")
const SOURCES = ["ragu/src", "util/src", "tui/src"]

const OLD_NAME = [
  /["'`/\\]\.nikcli(?=["'`/\\])/, // a .nikcli path segment in a string
  /\bnikcli\.jsonc?(?=["'`])/, // nikcli.json(c) ending a string
  /\bjoin\([^)\n]*["'`]nikcli["'`]/, // join(…, "nikcli")
  /const app = "nikcli"/,
  /"nikcli" \| "tui"/,
  /(?:fileInDirectory|configFilesInDirectory)\([^)\n]*"nikcli"\)/,
  /return "nikcli"/,
  /targets: \[["']\.nikcli["']\]/,
  /endsWith\(["']\.nikcli["']\)/,
]

/** File (relative to packages/) → why it may name the old folder. */
const ALLOWED: Record<string, string> = {
  "util/src/app-folder.ts": "rule B itself",
  "ragu/src/project/project.ts": "the project id cached in .git/nikcli: inside the repository's own .git, not a user folder",
  "tui/src/context/theme-catalog.ts": "the bundled theme file ./theme/nikcli.json, not a user's",
  "ragu/src/tool/plugin.txt": "text the model reads: the prompt commit",
  "ragu/src/installation/index.ts":
    "kept whole for the services brief (codemod upstream-registry): it names nikcli's install in ~/.nikcli/bin and its registry manifests",
  "tui/src/component/dialog-config.tsx": "text shown to the user, not a path read: the brand commit",
  "tui/src/component/dialog-onboarding.tsx": "text shown to the user, not a path read: the brand commit",
}

function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(full))
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

describe("every reader and guard asks rule B for a user's folder", () => {
  test("no source names .nikcli, nikcli.json(c) or the nikcli folder itself", () => {
    const hits: string[] = []
    for (const source of SOURCES) {
      const dir = path.join(ROOT, source)
      if (!fs.existsSync(dir)) continue
      for (const file of sources(dir)) {
        const rel = path.relative(ROOT, file).replaceAll("\\", "/")
        if (ALLOWED[rel]) continue
        fs.readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, i) => {
            const code = line.replace(/^\s*(?:\/\/|\*|\/\*).*$/, "")
            if (OLD_NAME.some((pattern) => pattern.test(code))) hits.push(`${rel}:${i + 1}: ${line.trim()}`)
          })
      }
    }
    expect(hits).toEqual([])
  })
})
