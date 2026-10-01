import { describe, expect, test } from "bun:test"
import {
  KEEP_CAPTURES,
  MAX_AGE_DAYS,
  PROTECTED,
  oldCaptures,
  oldFiles,
  pruneChoices,
  pathKey,
  pruneFolders,
  pruneProject,
  pruneSummary,
  trackedFiles,
  type Listed,
  type Listings,
} from "./ade-prune"
import type { GitRun } from "./worktree-close"

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 2, 12, 0, 0)
const BASE = "C:/work/app/.ade"
/** Nothing in git. */
const none: ReadonlySet<string> = new Set()

/** A fake git for `ls-files`: what the project tracks (relative paths), or a failure; every call is kept. */
function gitSays(tracked?: string[] | "fails") {
  const calls: { args: string[]; cwd: string | undefined }[] = []
  const run: GitRun = async (_command, args, cwd) => {
    calls.push({ args, cwd })
    if (tracked === "fails") return { code: 128, stdout: "", stderr: "fatal: not a git repository" }
    return { code: 0, stdout: (tracked ?? []).map((file) => file + "\0").join(""), stderr: "" }
  }
  return Object.assign(run, { calls })
}

const file = (folder: string, name: string, ageDays: number): Listed => ({
  name,
  path: `${BASE}/${folder}/${name}`,
  is_dir: false,
  modified_ms: NOW - ageDays * DAY,
})
const dir = (folder: string, name: string): Listed => ({ name, path: `${BASE}/${folder}/${name}`, is_dir: true, modified_ms: NOW - 400 * DAY })

/** `n` captures, the first being the newest: `<stamp>-p.png` and `<stamp>-p.md`, an hour apart. */
function captures(n: number): Listed[] {
  const out: Listed[] = []
  for (let i = 0; i < n; i++) {
    const stem = `20260901-${String(1000 + i).padStart(6, "0")}-anteprima`
    const age = (i * 3600_000) / DAY
    out.push(file("browser", `${stem}.png`, age), file("browser", `${stem}.md`, age))
  }
  return out
}

function host(listings: Record<string, Listed[]>, options: { readFails?: string[]; pruneFails?: boolean; tracked?: string[] | "fails" } = {}) {
  const removed: string[][] = []
  return {
    removed,
    run: gitSays(options.tracked),
    readDir: async (path: string) => {
      if (options.readFails?.includes(path)) throw new Error("manca")
      return listings[path] ?? []
    },
    adePrune: async (paths: string[]) => {
      if (options.pruneFails) throw new Error("host")
      removed.push(paths)
      return paths.length * 100
    },
  }
}

describe("the captures of the browser pane: the last fifty, in pairs", () => {
  test("fifty or fewer: nothing is chosen", () => {
    expect(oldCaptures(captures(KEEP_CAPTURES))).toEqual([])
    expect(oldCaptures(captures(3))).toEqual([])
    expect(oldCaptures([])).toEqual([])
  })

  test("a fifty-first capture takes the oldest one out, with both of its files", () => {
    const all = captures(KEEP_CAPTURES + 1)
    const oldest = all.slice(-2).map((entry) => entry.path)
    expect(oldCaptures(all).sort()).toEqual(oldest.sort())
  })

  test("what is kept is the newest by time, whatever the order of the listing", () => {
    const all = captures(60).reverse()
    const dropped = oldCaptures(all)
    expect(dropped).toHaveLength(20)
    // The ten oldest captures of the sixty (indices 50..59 before the reverse) are the ones that go.
    const names = dropped.map((path) => path.split("/").pop()!)
    for (let i = 50; i < 60; i++) {
      const stem = `20260901-${String(1000 + i).padStart(6, "0")}-anteprima`
      expect(names).toContain(`${stem}.png`)
      expect(names).toContain(`${stem}.md`)
    }
  })

  test("a capture is never half dropped: both files go, or none", () => {
    const all = captures(75)
    const dropped = new Set(oldCaptures(all))
    for (let i = 0; i < 75; i++) {
      const stem = `20260901-${String(1000 + i).padStart(6, "0")}-anteprima`
      const png = dropped.has(`${BASE}/browser/${stem}.png`)
      const md = dropped.has(`${BASE}/browser/${stem}.md`)
      expect(png).toBe(md)
    }
  })

  test("a lone .md or .png counts as a capture of its own", () => {
    const all = [...captures(KEEP_CAPTURES), file("browser", "orfano.md", 400)]
    expect(oldCaptures(all)).toEqual([`${BASE}/browser/orfano.md`])
  })

  test("other files and folders in browser/ are not captures: the .gitignore, a folder, a file of another kind", () => {
    const all = [...captures(KEEP_CAPTURES + 1), file("browser", ".gitignore", 900), dir("browser", "vecchio"), file("browser", "nota.txt", 900), file("browser", "dati.json", 900)]
    const dropped = oldCaptures(all)
    expect(dropped).toHaveLength(2)
    for (const path of dropped) expect(path).toMatch(/anteprima\.(png|md)$/)
  })

  test("the number kept can be given, and a nonsense one keeps nothing back", () => {
    expect(oldCaptures(captures(5), 2)).toHaveLength(6)
    expect(oldCaptures(captures(2), -1)).toHaveLength(4)
  })
})

describe("results and design notes: what is older than thirty days", () => {
  test("only the older .md files go; a younger one, a folder, another kind of file stay", () => {
    const listed = [
      file("results", "vecchio.md", MAX_AGE_DAYS + 1),
      file("results", "recente.md", MAX_AGE_DAYS - 1),
      file("results", "appena.md", 0),
      dir("results", "sotto"),
      file("results", "log.txt", 200),
    ]
    expect(oldFiles(listed, NOW, ["md"])).toEqual([`${BASE}/results/vecchio.md`])
  })

  test("the day itself: thirty days exactly is not older than thirty days", () => {
    expect(oldFiles([file("results", "giusto.md", MAX_AGE_DAYS)], NOW, ["md"])).toEqual([])
    expect(oldFiles([file("results", "giusto.md", MAX_AGE_DAYS + 0.001)], NOW, ["md"])).toHaveLength(1)
  })

  test("a file whose time the host could not read is left alone", () => {
    expect(oldFiles([{ name: "ignoto.md", path: `${BASE}/results/ignoto.md`, is_dir: false, modified_ms: 0 }], NOW, ["md"])).toEqual([])
  })

  test("the extension is read whatever its case, and a name with no extension is nothing", () => {
    const listed = [file("results", "MAIUSCOLO.MD", 90), file("results", "senza", 90), file("results", ".md", 90)]
    expect(oldFiles(listed, NOW, ["md"])).toEqual([`${BASE}/results/MAIUSCOLO.MD`])
  })
})

describe("what is never chosen", () => {
  const protectedFiles = [...PROTECTED].map((name) => file("results", name, 900))
  const everywhere: Listings = {
    browser: [...protectedFiles.map((entry) => ({ ...entry, path: entry.path.replace("/results/", "/browser/") })), ...captures(KEEP_CAPTURES)],
    results: protectedFiles,
    notes: protectedFiles.map((entry) => ({ ...entry, path: entry.path.replace("/results/", "/design/note/") })),
  }

  test("the project's memory and the .gitignore are the four names, and they are protected", () => {
    expect([...PROTECTED].sort()).toEqual([".gitignore", "decisions.jsonl", "design.jsonl", "memory.md"])
  })

  test("not in browser/, results/ or design/note/, however old and wherever listed", () => {
    expect(pruneChoices(everywhere, NOW, none)).toEqual([])
  })

  test("not in a different case either", () => {
    const shouting: Listings = { browser: [], results: [file("results", "MEMORY.MD", 900), file("results", "Decisions.JSONL", 900)], notes: [file("design/note", "MEMORY.md", 900)] }
    expect(pruneChoices(shouting, NOW, none)).toEqual([])
  })

  test("the previews of the design proposals are not listed here, so they are not chosen: design/<k>/<n>.html", () => {
    // The caller lists three folders only; design/note is one of them, design/ itself is not.
    const listings: Listings = { browser: [], results: [], notes: [file("design/note", "a.md", 100)] }
    expect(pruneChoices(listings, NOW, none)).toEqual([`${BASE}/design/note/a.md`])
  })
})

describe("all three folders at once", () => {
  test("each folder follows its own rule, and the answer is the sum", () => {
    const listings: Listings = {
      browser: captures(KEEP_CAPTURES + 2),
      results: [file("results", "a.md", 31), file("results", "b.md", 1)],
      notes: [file("design/note", "n.md", 45), file("design/note", "m.md", 2)],
    }
    const chosen = pruneChoices(listings, NOW, none)
    expect(chosen).toHaveLength(4 + 1 + 1)
    expect(chosen).toContain(`${BASE}/results/a.md`)
    expect(chosen).toContain(`${BASE}/design/note/n.md`)
    expect(chosen).not.toContain(`${BASE}/results/b.md`)
    expect(chosen).not.toContain(`${BASE}/design/note/m.md`)
  })

  test("nothing to prune is an empty list, not a call", () => {
    expect(pruneChoices({ browser: [], results: [], notes: [] }, NOW, none)).toEqual([])
  })
})

describe("the folders of a project", () => {
  test("with the separator the project's own path uses", () => {
    expect(pruneFolders("C:/work/app/")).toEqual({ browser: "C:/work/app/.ade/browser", results: "C:/work/app/.ade/results", notes: "C:/work/app/.ade/design/note" })
    const windows = pruneFolders("C:" + String.fromCharCode(92) + "work" + String.fromCharCode(92) + "app")
    expect(windows.browser).toBe("C:" + String.fromCharCode(92) + "work" + String.fromCharCode(92) + "app" + String.fromCharCode(92) + ".ade" + String.fromCharCode(92) + "browser")
    expect(windows.notes.endsWith(String.fromCharCode(92) + "design" + String.fromCharCode(92) + "note")).toBe(true)
  })
})

describe("pruning a project through the host", () => {

  test("it lists the three folders, hands over what is chosen, and returns the bytes freed", async () => {
    const h = host({ "C:/work/app/.ade/results": [file("results", "a.md", 40), file("results", "b.md", 2)] })
    expect(await pruneProject(h, "C:/work/app", NOW)).toBe(100)
    expect(h.removed).toEqual([[`${BASE}/results/a.md`]])
  })

  test("a folder that is not there is an empty listing, not a failure", async () => {
    const h = host({ "C:/work/app/.ade/results": [file("results", "a.md", 40)] }, { readFails: ["C:/work/app/.ade/browser", "C:/work/app/.ade/design/note"] })
    expect(await pruneProject(h, "C:/work/app", NOW)).toBe(100)
  })

  test("nothing chosen: the host is not called", async () => {
    const h = host({})
    expect(await pruneProject(h, "C:/work/app", NOW)).toBe(0)
    expect(h.removed).toEqual([])
  })

  test("a host that cannot list or remove is zero, and never throws", async () => {
    expect(await pruneProject({}, "C:/work/app", NOW)).toBe(0)
    expect(await pruneProject({ readDir: async () => [] }, "C:/work/app", NOW)).toBe(0)
    const failing = host({ "C:/work/app/.ade/results": [file("results", "a.md", 40)] }, { pruneFails: true })
    expect(await pruneProject(failing, "C:/work/app", NOW)).toBe(0)
  })
})

describe("pruneSummary", () => {
  const sized = (entry: Listed, size: number): Listed => ({ ...entry, size })

  test("the paths are the ones pruneChoices picks, and the bytes are those of exactly those files", () => {
    const old = sized(file("results", "old.md", 40), 3000)
    const fresh = sized(file("results", "fresh.md", 2), 9000)
    const oldNote = sized(file("note", "n.md", 31), 500)
    const listings: Listings = { browser: [], results: [old, fresh], notes: [oldNote] }
    const summary = pruneSummary(listings, NOW, none)
    expect(summary.paths).toEqual(pruneChoices(listings, NOW, none))
    expect(summary.bytes).toBe(3500)
  })

  test("a file with no known size weighs nothing, and nothing to prune is zero", () => {
    const summary = pruneSummary({ browser: [], results: [file("results", "old.md", 40)], notes: [] }, NOW, none)
    expect(summary.paths).toHaveLength(1)
    expect(summary.bytes).toBe(0)
    expect(pruneSummary({ browser: [], results: [], notes: [] }, NOW, none)).toEqual({ paths: [], bytes: 0 })
  })

  test("the project's memory is never counted, however old and big", () => {
    const memory = sized(file("results", "memory.md", 900), 99_999)
    expect(pruneSummary({ browser: [], results: [memory], notes: [] }, NOW, none)).toEqual({ paths: [], bytes: 0 })
  })
})

describe("what git tracks is the project's, not ADE's", () => {
  const trackedOld = file("results", "kept.md", 400)
  const looseOld = file("results", "loose.md", 400)

  test("an old file that git tracks is not chosen, and one that it does not is", () => {
    const listings: Listings = { browser: [], results: [trackedOld, looseOld], notes: [] }
    const tracked = new Set([`${BASE}/results/kept.md`.toLowerCase()])
    expect(pruneChoices(listings, NOW, tracked)).toEqual([looseOld.path])
    expect(pruneChoices(listings, NOW, none)).toEqual([trackedOld.path, looseOld.path])
  })

  test("a capture of the browser pane with one of its two files tracked loses only the other", () => {
    const old = captures(KEEP_CAPTURES + 1).slice(-2)
    const tracked = new Set([old[0]!.path.toLowerCase()])
    const chosen = pruneChoices({ browser: captures(KEEP_CAPTURES + 1), results: [], notes: [] }, NOW, tracked)
    expect(chosen).toEqual([old[1]!.path])
  })

  test("the summary counts only what would be removed", () => {
    const sized = (entry: Listed, size: number): Listed => ({ ...entry, size })
    const listings: Listings = { browser: [], results: [sized(trackedOld, 5000), sized(looseOld, 70)], notes: [] }
    const summary = pruneSummary(listings, NOW, new Set([trackedOld.path.toLowerCase()]))
    expect(summary).toEqual({ paths: [looseOld.path], bytes: 70 })
  })

  test("trackedFiles asks git once, in the project, for the three folders only, and reads the names up to the NUL", async () => {
    const run = gitSays([".ade/results/Kept One.md", ".ade/design/note/n.md"])
    const tracked = await trackedFiles(run, "C:/work/app/")
    expect(run.calls).toEqual([{ args: ["ls-files", "-z", "--", ".ade/browser", ".ade/results", ".ade/design/note"], cwd: "C:/work/app/" }])
    expect([...tracked!].sort()).toEqual(["c:/work/app/.ade/design/note/n.md", "c:/work/app/.ade/results/kept one.md"])
  })

  test("a project written with backslashes compares the same", async () => {
    const run = gitSays([".ade/results/a.md"])
    const tracked = await trackedFiles(run, "C:\\Work\\App")
    expect(tracked?.has(pathKey("C:\\work\\app\\.ade\\results\\A.md"))).toBe(true)
    expect(run.calls[0]!.args.slice(3)).toEqual([".ade/browser", ".ade/results", ".ade/design/note"])
  })

  test("git that cannot answer is no answer: nothing may be taken for untracked", async () => {
    expect(await trackedFiles(gitSays("fails"), "C:/work/app")).toBeUndefined()
    const throwing: GitRun = async () => {
      throw new Error("git non c'è")
    }
    expect(await trackedFiles(throwing, "C:/work/app")).toBeUndefined()
  })

  test("pruneProject spares a tracked file and removes the rest", async () => {
    const h = host({ "C:/work/app/.ade/results": [trackedOld, looseOld] }, { tracked: [".ade/results/kept.md"] })
    expect(await pruneProject(h, "C:/work/app", NOW)).toBe(100)
    expect(h.removed).toEqual([[looseOld.path]])
  })

  test("pruneProject with git failing, or with no git at all, removes nothing and does not even ask the host to", async () => {
    const failing = host({ "C:/work/app/.ade/results": [looseOld] }, { tracked: "fails" })
    expect(await pruneProject(failing, "C:/work/app", NOW)).toBe(0)
    expect(failing.removed).toEqual([])
    const { run: _run, ...noGit } = host({ "C:/work/app/.ade/results": [looseOld] })
    expect(await pruneProject(noGit, "C:/work/app", NOW)).toBe(0)
    expect(noGit.removed).toEqual([])
  })
})
