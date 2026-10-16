import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { excludeBotFiles, excludeWithBotFiles } from "./attach"

/*
 * bot-ui-3, 2: the pictures pasted for a bot live in `<project>/.ade/bots/<name>/`, and must not show up in the user's
 * `git status`. The project's own `.git/info/exclude` gets `.ade/bots/` (local, never in a commit), never its
 * `.gitignore`, which is the user's.
 */
describe("the bots' pictures stay out of the project's git", () => {
  test("the line is added once, after what is there; a line that already covers it is left alone", () => {
    expect(excludeWithBotFiles("")).toBe("# ADE: immagini date ai bot\n.ade/bots/\n")
    expect(excludeWithBotFiles("# git ls-files --others\n*.log")).toBe(
      "# git ls-files --others\n*.log\n# ADE: immagini date ai bot\n.ade/bots/\n",
    )
    for (const there of [".ade/bots/", ".ade/bots", "/.ade/bots/", ".ade/", ".ade", "/.ade/"])
      expect(excludeWithBotFiles(`*.log\r\n${there}\r\n`)).toBeUndefined()
  })

  const fake = (options: { revParse?: { code: number; stdout: string }; current?: string } = {}) => {
    const calls = { run: [] as string[][], read: [] as string[], written: [] as [string, string][] }
    const host = {
      run: async (command: string, args: string[], cwd?: string) => {
        calls.run.push([command, ...args, `@${cwd}`])
        return { ...(options.revParse ?? { code: 0, stdout: ".git\n" }), stderr: "" }
      },
      readTextFile: async (path: string) => {
        calls.read.push(path)
        if (options.current === undefined) throw new Error("non c'è")
        return { text: options.current }
      },
      writeTextFile: async (path: string, text: string) => {
        calls.written.push([path, text])
        return null
      },
    }
    return { host, calls }
  }

  test("a git repository: its common folder is asked of git, and its info/exclude gets the line", async () => {
    const { host, calls } = fake({ current: "*.log\n" })
    expect(await excludeBotFiles("C:/progetto", host)).toBe("added")
    expect(calls.run).toEqual([["git", "rev-parse", "--git-common-dir", "@C:/progetto"]])
    expect(calls.written).toEqual([
      ["C:/progetto/.git/info/exclude", "*.log\n# ADE: immagini date ai bot\n.ade/bots/\n"],
    ])
  })

  test("a worktree names its common folder whole; a file not there yet is made", async () => {
    const { host, calls } = fake({ revParse: { code: 0, stdout: "C:/main/.git\n" } })
    expect(await excludeBotFiles("C:/progetto", host)).toBe("added")
    expect(calls.written[0]?.[0]).toBe("C:/main/.git/info/exclude")
  })

  test("not a repository, or the line already there: nothing is written", async () => {
    const none = fake({ revParse: { code: 128, stdout: "" } })
    expect(await excludeBotFiles("C:/progetto", none.host)).toBe("none")
    expect(none.calls.written).toEqual([])
    const there = fake({ current: ".ade/\n" })
    expect(await excludeBotFiles("C:/progetto", there.host)).toBe("there")
    expect(there.calls.written).toEqual([])
  })

  test("a failure is never thrown: a picture in git status is a nuisance, not a reason to refuse it", async () => {
    const host = {
      run: async () => {
        throw new Error("git assente")
      },
      readTextFile: async () => ({ text: "" }),
      writeTextFile: async () => "negato",
    }
    expect(await excludeBotFiles("C:/progetto", host)).toBe("none")
  })

  test("lint: the first picture saved in a project asks for the line, and nothing touches a .gitignore", () => {
    const attach = readFileSync(join(import.meta.dir, "attach.ts"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")
    expect(attach).not.toContain(".gitignore")
    const tsx = readFileSync(join(import.meta.dir, "bots.tsx"), "utf8")
    const pictures = tsx.slice(tsx.indexOf("const addPictures = async"), tsx.indexOf("const pickFiles = async"))
    expect(pictures).toContain("excludeBotFilesOnce(root, host)")
    expect(pictures.indexOf("savePasted(")).toBeLessThan(pictures.indexOf("excludeBotFilesOnce(root, host)"))
  })
})
