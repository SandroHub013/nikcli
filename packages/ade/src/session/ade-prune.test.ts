import { describe, expect, test } from "bun:test"
import {
  KEEP_CAPTURES,
  MAX_AGE_DAYS,
  PROTECTED,
  oldCaptures,
  oldFiles,
  pruneChoices,
  pruneFolders,
  pruneProject,
  type Listed,
  type Listings,
} from "./ade-prune"

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 2, 12, 0, 0)
const BASE = "C:/work/app/.ade"

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
    expect(pruneChoices(everywhere, NOW)).toEqual([])
  })

  test("not in a different case either", () => {
    const shouting: Listings = { browser: [], results: [file("results", "MEMORY.MD", 900), file("results", "Decisions.JSONL", 900)], notes: [file("design/note", "MEMORY.md", 900)] }
    expect(pruneChoices(shouting, NOW)).toEqual([])
  })

  test("the previews of the design proposals are not listed here, so they are not chosen: design/<k>/<n>.html", () => {
    // The caller lists three folders only; design/note is one of them, design/ itself is not.
    const listings: Listings = { browser: [], results: [], notes: [file("design/note", "a.md", 100)] }
    expect(pruneChoices(listings, NOW)).toEqual([`${BASE}/design/note/a.md`])
  })
})

describe("all three folders at once", () => {
  test("each folder follows its own rule, and the answer is the sum", () => {
    const listings: Listings = {
      browser: captures(KEEP_CAPTURES + 2),
      results: [file("results", "a.md", 31), file("results", "b.md", 1)],
      notes: [file("design/note", "n.md", 45), file("design/note", "m.md", 2)],
    }
    const chosen = pruneChoices(listings, NOW)
    expect(chosen).toHaveLength(4 + 1 + 1)
    expect(chosen).toContain(`${BASE}/results/a.md`)
    expect(chosen).toContain(`${BASE}/design/note/n.md`)
    expect(chosen).not.toContain(`${BASE}/results/b.md`)
    expect(chosen).not.toContain(`${BASE}/design/note/m.md`)
  })

  test("nothing to prune is an empty list, not a call", () => {
    expect(pruneChoices({ browser: [], results: [], notes: [] }, NOW)).toEqual([])
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
  function host(listings: Record<string, Listed[]>, options: { readFails?: string[]; pruneFails?: boolean } = {}) {
    const removed: string[][] = []
    return {
      removed,
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
