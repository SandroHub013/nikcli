import { describe, expect, test } from "bun:test"
import { createAdeVoiceHost, type AdeVoiceHostDeps } from "./host"
import { dictatedFile, isRecentRoot } from "./paths"
import { createWorkbench } from "../surface/state"
import type { Project } from "../host/project"

/*
 * M11 (verdict of area 3): «apri file C:/Users/…/.ssh/id_rsa» opened the key,
 * and «apri il progetto recente <any folder>» opened any folder as a project,
 * both without a question. Inside the project and among the recents: as
 * before. Anything else: asked, and a no opens nothing.
 */
const ROOT = "C:/Users/me/progetto"

describe("a dictated file", () => {
  test("inside the project it opens on its own; a relative one is the project's", () => {
    expect(dictatedFile("C:/Users/me/progetto/src/index.ts", ROOT)).toEqual({
      path: "C:/Users/me/progetto/src/index.ts",
      inside: true,
    })
    expect(dictatedFile("src/index.ts", ROOT)).toEqual({ path: "C:/Users/me/progetto/src/index.ts", inside: true })
    expect(dictatedFile("c:\\users\\me\\progetto\\README.md", ROOT).inside).toBe(true)
  })

  test("outside the project, `..` included, or with no project open, it is not", () => {
    expect(dictatedFile("C:/Users/me/.ssh/id_rsa", ROOT).inside).toBe(false)
    expect(dictatedFile("../.ssh/id_rsa", ROOT)).toEqual({ path: "C:/Users/me/progetto/../.ssh/id_rsa", inside: false })
    expect(dictatedFile("//server/share/x.txt", ROOT).inside).toBe(false)
    expect(dictatedFile("src/index.ts", undefined).inside).toBe(false)
  })
})

describe("a dictated project", () => {
  const recents = [{ root: "C:/Users/me/progetto" }, { root: "D:/lavoro/altro" }]

  test("is a recent one however it is spelled", () => {
    expect(isRecentRoot("C:/Users/me/progetto", recents)).toBe(true)
    expect(isRecentRoot("c:\\users\\me\\progetto\\", recents)).toBe(true)
  })

  test("a folder inside or above a recent one, or anywhere else, is not", () => {
    expect(isRecentRoot("C:/Users/me/progetto/src", recents)).toBe(false)
    expect(isRecentRoot("C:/Users/me", recents)).toBe(false)
    expect(isRecentRoot("C:/Windows", recents)).toBe(false)
    expect(isRecentRoot("", recents)).toBe(false)
  })
})

describe("the voice host asks before a path voice does not open on its own", () => {
  function host(answer: boolean | undefined) {
    const opened: string[] = []
    const run: string[] = []
    const asked: string[] = []
    const deps: AdeVoiceHostDeps = {
      wb: () => createWorkbench(),
      setWb: () => {},
      project: () => ({ root: ROOT, name: "progetto" }) as Project,
      runCommand: async (id) => void run.push(id),
      isRunning: () => false,
      getRunningSession: () => undefined,
      openFile: async (path) => void opened.push(path),
      appendLine: () => {},
      tellPane: () => {},
      permissions: () => ({}),
      answerPermission: () => {},
      recents: () => [{ root: "D:/lavoro/altro", name: "altro", openedAt: 1 }],
      ...(answer === undefined ? {} : { confirm: async (question: string) => (asked.push(question), answer) }),
    }
    return { voice: createAdeVoiceHost(deps), opened, run, asked }
  }

  test("a file in the project and a recent project: no question", async () => {
    const { voice, opened, run, asked } = host(false)
    await voice.openFile("src/index.ts")
    await voice.runCommand("project.recent.D:/lavoro/altro")
    expect(opened).toEqual(["C:/Users/me/progetto/src/index.ts"])
    expect(run).toEqual(["project.recent.D:/lavoro/altro"])
    expect(asked).toEqual([])
  })

  test("a no opens nothing and says why", async () => {
    const { voice, opened, run, asked } = host(false)
    await expect(voice.openFile("C:/Users/me/.ssh/id_rsa")).rejects.toThrow("negato dall'utente")
    await expect(voice.runCommand("project.recent.C:/Windows")).rejects.toThrow("negato dall'utente")
    expect(opened).toEqual([])
    expect(run).toEqual([])
    expect(asked).toHaveLength(2)
    expect(asked[0]).toContain("C:/Users/me/.ssh/id_rsa")
    expect(asked[1]).toContain("C:/Windows")
  })

  test("a yes opens it", async () => {
    const { voice, opened, run } = host(true)
    await voice.openFile("C:/Users/me/Desktop/note.md")
    await voice.runCommand("project.recent.C:/Users/me/nuovo")
    expect(opened).toEqual(["C:/Users/me/Desktop/note.md"])
    expect(run).toEqual(["project.recent.C:/Users/me/nuovo"])
  })

  test("with no one to ask, the answer is no", async () => {
    const { voice, opened, run } = host(undefined)
    await expect(voice.openFile("C:/Users/me/.ssh/id_rsa")).rejects.toThrow()
    await expect(voice.runCommand("project.recent.C:/Windows")).rejects.toThrow()
    expect(opened).toEqual([])
    expect(run).toEqual([])
  })
})
