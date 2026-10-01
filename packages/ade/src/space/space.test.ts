import { describe, expect, test } from "bun:test"
import { createSpace, formatBytes, normalized, parseWorktrees, plainBranches, type SpaceDeps, type SpaceHost } from "./space"

const ROOT = "C:/work/app"
const FIX = "C:/work/app-worktrees/fix"
const OLD = "C:/work/app-worktrees/old"
const NOW = Date.UTC(2026, 9, 2, 12, 0, 0)
const DAY = 24 * 60 * 60 * 1000

const PORCELAIN = [
  `worktree ${ROOT}`,
  "HEAD 1111",
  "branch refs/heads/main",
  "",
  `worktree ${FIX}`,
  "HEAD 2222",
  "branch refs/heads/ade/fix",
  "",
  `worktree ${OLD}`,
  "HEAD 3333",
  "branch refs/heads/ade/old",
  "",
].join("\n")

/** A fake git that answers by arguments, and remembers every call with where it ran. */
function git(says: Record<string, { code?: number; stdout?: string; stderr?: string }> = {}) {
  const calls: string[] = []
  const run: NonNullable<SpaceHost["run"]> = async (_command, args, cwd) => {
    const key = args.join(" ")
    calls.push(`${key} @ ${cwd}`)
    const reply = says[key] ?? {}
    return { code: reply.code ?? 0, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" }
  }
  return { run, calls }
}

const destructive = (calls: string[]) => calls.filter((call) => call.startsWith("worktree remove") || call.startsWith("branch -d") || call.startsWith("branch -D"))

/** A project with a worktree that has landed (fix), one with work in it (old), a branch of ADE that has landed and no worktree (done). */
const LANDED_FIX = { "branch --list ade/fix --merged": { stdout: "  ade/fix\n" } }
const DIRTY_OLD = { [`status --porcelain`]: { stdout: "" } }

function setup(over: Partial<SpaceHost> = {}, deps: Partial<SpaceDeps> = {}, says: Record<string, { code?: number; stdout?: string; stderr?: string }> = {}) {
  const fake = git({
    "worktree list --porcelain": { stdout: PORCELAIN },
    ...LANDED_FIX,
    "branch --list ade/old --merged": { stdout: "" },
    "branch --list ade/* --merged": { stdout: "  ade/done\n+ ade/fix\n* main\n  ade/other\n" },
    ...says,
  })
  const asked: string[] = []
  const removedBy: string[] = []
  const host: SpaceHost = {
    ttsDiskReport: async () => ({ piper: { runtime: 190_000_000, voices: [{ id: "ugo", bytes: 63_000_000 }, { id: "paola", bytes: 64_000_000 }] }, kokoro: 219_000_000 }),
    ttsPiperDelete: async (id) => {
      removedBy.push(`piper ${id ?? "all"}`)
      return 1
    },
    ttsLocalDelete: async (provider) => void removedBy.push(`local ${provider}`),
    nikverseAssetsBytes: async () => 40_000_000,
    nikverseAssetsRemove: async () => {
      removedBy.push("nikverse")
      return 40_000_000
    },
    run: fake.run,
    readDir: async (path) => (path.endsWith("/results") ? [{ name: "a.md", path: `${ROOT}/.ade/results/a.md`, is_dir: false, modified_ms: NOW - 40 * DAY, size: 3000 }] : []),
    adePrune: async (paths) => {
      removedBy.push(`prune ${paths.length}`)
      return 3000
    },
    adeContainerRemove: async (root) => {
      removedBy.push(`container ${root}`)
      return true
    },
    adeWorktreeBytes: async (_root, path) => (path === FIX ? 300_000_000 : 120_000_000),
    ...over,
  }
  const answers = { next: true }
  const space = createSpace({
    host,
    roots: () => [ROOT],
    openWorktrees: () => [],
    ask: async (message) => {
      asked.push(message)
      return answers.next
    },
    now: () => NOW,
    ...deps,
  })
  return { space, fake, host, asked, removedBy, answers }
}

const ids = (rows: { id: string }[]) => rows.map((row) => row.id)

describe("what the panel lists", () => {
  test("a row for each thing: the voices, the assets, the worktrees, the branches that landed and the old files of .ade/", async () => {
    const { space } = setup()
    const rows = await space.refresh()
    expect(ids(rows)).toEqual([
      "piper:ugo",
      "piper:paola",
      "kokoro",
      "nikverse",
      `worktree:${normalized(FIX)}`,
      `worktree:${normalized(OLD)}`,
      `branches:${normalized(ROOT)}`,
      `prune:${normalized(ROOT)}`,
    ])
    expect(rows.find((row) => row.id === "kokoro")?.bytes).toBe(219_000_000)
    expect(rows.find((row) => row.id === "nikverse")?.bytes).toBe(40_000_000)
    expect(rows.find((row) => row.id === `prune:${normalized(ROOT)}`)?.bytes).toBe(3000)
  })

  test("with two Piper voices each frees its own weight; the last one frees the runtime with it", async () => {
    const two = setup()
    const rows = await two.space.refresh()
    expect(rows.find((row) => row.id === "piper:ugo")?.bytes).toBe(63_000_000)
    const one = setup({ ttsDiskReport: async () => ({ piper: { runtime: 190_000_000, voices: [{ id: "ugo", bytes: 63_000_000 }] }, kokoro: 0 }) })
    const last = (await one.space.refresh()).find((row) => row.id === "piper:ugo")!
    expect(last.bytes).toBe(253_000_000)
    expect(last.detail).toBeTruthy()
  })

  test("a runtime with no voice left is a row of its own, and nothing installed is no row", async () => {
    const left = setup({ ttsDiskReport: async () => ({ piper: { runtime: 190_000_000, voices: [] }, kokoro: 0 }) })
    expect(ids(await left.space.refresh()).slice(0, 1)).toEqual(["piper:all"])
    const none = setup({ ttsDiskReport: async () => ({ piper: { runtime: 0, voices: [] }, kokoro: 0 }), nikverseAssetsBytes: async () => 0, run: undefined, readDir: undefined })
    expect(await none.space.refresh()).toEqual([])
  })

  test("a worktree that has landed and is clean is offered; one with work in it is listed with why and has no button", async () => {
    const { space } = setup({}, {}, { "branch --list ade/old --merged": { stdout: "" } })
    const rows = await space.refresh()
    const fix = rows.find((row) => row.id === `worktree:${normalized(FIX)}`)!
    const old = rows.find((row) => row.id === `worktree:${normalized(OLD)}`)!
    expect(fix.action).toBeTruthy()
    expect(fix.kept).toBeUndefined()
    expect(fix.bytes).toBe(300_000_000)
    expect(old.action).toBeUndefined()
    expect(old.kept).toContain("ade/old")
  })

  test("changes that were not committed keep a worktree listed, never offered", async () => {
    const { space } = setup({}, {}, { "status --porcelain": { stdout: " M src/a.ts\n" } })
    const rows = (await space.refresh()).filter((row) => row.group === "worktrees")
    expect(rows.every((row) => row.action === undefined && Boolean(row.kept))).toBe(true)
  })

  test("a worktree with a session open in it is not listed at all, in either spelling of its path", async () => {
    const { space } = setup({}, { openWorktrees: () => ["C:\\work\\app-worktrees\\FIX\\".replace("FIX", "fix")] })
    const rows = await space.refresh()
    expect(rows.some((row) => row.id === `worktree:${normalized(FIX)}`)).toBe(false)
    expect(rows.some((row) => row.id === `worktree:${normalized(OLD)}`)).toBe(true)
  })

  test("not the project itself, not a worktree outside its folder, not one on a branch that is not ADE's", async () => {
    const porcelain = [
      `worktree ${ROOT}`, "HEAD 1", "branch refs/heads/ade/main-like", "",
      "worktree C:/elsewhere/side", "HEAD 2", "branch refs/heads/ade/side", "",
      `worktree C:/work/app-worktrees/mine`, "HEAD 3", "branch refs/heads/feature/mine", "",
      `worktree C:/work/app-worktrees/detached`, "HEAD 4", "detached", "",
    ].join("\n")
    const { space } = setup({}, {}, { "worktree list --porcelain": { stdout: porcelain } })
    const rows = await space.refresh()
    expect(rows.filter((row) => row.group === "worktrees")).toEqual([])
  })

  test("a locked worktree is listed and kept", async () => {
    const porcelain = `${PORCELAIN}worktree C:/work/app-worktrees/lock\nHEAD 4\nbranch refs/heads/ade/lock\nlocked\n`
    const { space } = setup({}, {}, { "worktree list --porcelain": { stdout: porcelain }, "branch --list ade/lock --merged": { stdout: "  ade/lock\n" } })
    const locked = (await space.refresh()).find((row) => row.id === `worktree:${normalized("C:/work/app-worktrees/lock")}`)!
    expect(locked.action).toBeUndefined()
    expect(locked.kept).toBeTruthy()
  })

  test("the branches row names only plain landed branches of ADE, not the current one nor one checked out in a worktree", async () => {
    const { space } = setup()
    const row = (await space.refresh()).find((candidate) => candidate.group === "branches")!
    expect(row.detail).toContain("ade/done")
    expect(row.detail).toContain("ade/other")
    expect(row.detail).not.toContain("ade/fix")
    expect(row.detail).not.toContain("main")
  })

  test("a host that cannot do a thing has no row for it", async () => {
    const { space } = setup({ ttsDiskReport: undefined, nikverseAssetsBytes: undefined, run: undefined, readDir: undefined, adePrune: undefined })
    expect(await space.refresh()).toEqual([])
  })

  test("nothing of a project's memory is ever a row", async () => {
    const { space } = setup({ readDir: async (path) => (path.endsWith("/results") ? [{ name: "memory.md", path: `${ROOT}/.ade/results/memory.md`, is_dir: false, modified_ms: NOW - 900 * DAY, size: 99 }] : []) })
    const rows = await space.refresh()
    expect(rows.some((row) => row.group === "project")).toBe(false)
    expect(JSON.stringify(rows)).not.toContain("decisions")
  })
})

describe("nothing goes without a question that says how much it frees", () => {
  test("the question names the row and says the size", async () => {
    const { space, asked } = setup()
    await space.refresh()
    await space.remove("kokoro")
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain("Kokoro")
    expect(asked[0]).toContain(formatBytes(219_000_000))
  })

  test("a no does nothing: no call to the host that deletes, no git that removes, nothing changes", async () => {
    const { space, fake, removedBy, answers } = setup()
    await space.refresh()
    answers.next = false
    for (const row of space.rows()) expect((await space.remove(row.id)).kind).toBe(row.action ? "declined" : "listed")
    expect(removedBy).toEqual([])
    expect(destructive(fake.calls)).toEqual([])
  })

  test("a row with no button is never asked about, and nothing runs for it", async () => {
    const { space, asked, fake } = setup({}, {}, { "status --porcelain": { stdout: " M a\n" } })
    await space.refresh()
    const kept = space.rows().find((row) => row.group === "worktrees")!
    const outcome = await space.remove(kept.id)
    expect(outcome.kind).toBe("listed")
    expect(asked).toEqual([])
    expect(destructive(fake.calls)).toEqual([])
  })

  test("a row that is gone is gone", async () => {
    const { space } = setup()
    await space.refresh()
    expect(await space.remove("piper:nobody")).toEqual({ kind: "gone" })
  })

  test("a second click while a question is open does not ask another", async () => {
    let answer: (yes: boolean) => void = () => {}
    const asked: string[] = []
    const { space } = setup({}, { ask: (message) => new Promise<boolean>((resolve) => { asked.push(message); answer = resolve }) })
    await space.refresh()
    const first = space.remove("kokoro")
    await Promise.resolve()
    expect(space.busy()).toBe(true)
    expect((await space.remove("nikverse")).kind).toBe("declined")
    answer(false)
    await first
    expect(asked).toHaveLength(1)
    expect(space.busy()).toBe(false)
  })
})

describe("what each button does", () => {
  test("a Piper voice: the host removes that voice, and the rows are read again", async () => {
    const { space, removedBy } = setup()
    await space.refresh()
    expect((await space.remove("piper:paola")).kind).toBe("done")
    expect(removedBy).toEqual(["piper paola"])
  })

  test("Kokoro, the assets and the old files of .ade/", async () => {
    const { space, removedBy } = setup()
    await space.refresh()
    expect(await space.remove("kokoro")).toEqual({ kind: "done", freed: 219_000_000 })
    expect(await space.remove("nikverse")).toEqual({ kind: "done", freed: 40_000_000 })
    expect(await space.remove(`prune:${normalized(ROOT)}`)).toEqual({ kind: "done", freed: 3000 })
    expect(removedBy).toEqual(["local kokoro", "nikverse", "prune 1"])
  })

  test("a worktree that has landed: removed, then its branch, then the folder beside the project if it is empty; the bytes it weighed", async () => {
    const { space, fake, removedBy } = setup()
    await space.refresh()
    const outcome = await space.remove(`worktree:${normalized(FIX)}`)
    expect(outcome).toEqual({ kind: "done", freed: 300_000_000 })
    expect(destructive(fake.calls)).toEqual([`worktree remove ${FIX} @ ${ROOT}`, `branch -d ade/fix @ ${ROOT}`])
    expect(removedBy).toContain(`container ${ROOT}`)
  })

  test("a worktree that got work in it since the list was read is not removed: the same check is made again at the click", async () => {
    const { space, fake } = setup()
    await space.refresh()
    // After the listing, the session wrote something in the folder.
    const run = fake.run
    const dirty = setup({}, {}, { "status --porcelain": { stdout: " M late.ts\n" } })
    await dirty.space.refresh()
    void run
    const row = `worktree:${normalized(FIX)}`
    // The rows read clean; the click reads the folder again and finds the change.
    const flip = git({ "worktree list --porcelain": { stdout: PORCELAIN }, ...LANDED_FIX, "branch --list ade/old --merged": { stdout: "" }, "branch --list ade/* --merged": { stdout: "" } })
    let late = false
    const host: SpaceHost = {
      run: async (command, args, cwd) => {
        if (args.join(" ") === "status --porcelain" && late) return { code: 0, stdout: " M late.ts\n", stderr: "" }
        return flip.run(command, args, cwd)
      },
      adeWorktreeBytes: async () => 1000,
    }
    const space2 = createSpace({ host, roots: () => [ROOT], openWorktrees: () => [], ask: async () => true, now: () => NOW })
    await space2.refresh()
    expect(space2.rows().find((r) => r.id === row)?.action).toBeTruthy()
    late = true
    const outcome = await space2.remove(row)
    expect(outcome.kind).toBe("failed")
    expect(destructive(flip.calls)).toEqual([])
  })

  test("the branches that landed: each one with branch -d, never -D", async () => {
    const { space, fake } = setup()
    await space.refresh()
    await space.remove(`branches:${normalized(ROOT)}`)
    expect(destructive(fake.calls)).toEqual([`branch -d ade/done @ ${ROOT}`, `branch -d ade/other @ ${ROOT}`])
  })

  test("a host that refuses (a synthesis is running, a download is writing) is a failure with its words, and nothing else is hidden", async () => {
    const { space } = setup({
      ttsPiperDelete: async () => {
        throw new Error("C'è una sintesi in corso: aspetta che finisca prima di cancellare.")
      },
    })
    await space.refresh()
    const outcome = await space.remove("piper:ugo")
    expect(outcome).toEqual({ kind: "failed", reason: "C'è una sintesi in corso: aspetta che finisca prima di cancellare." })
    expect(space.rows().length).toBeGreaterThan(0)
  })

  test("the rows are read again after a removal, so what is gone is no longer there", async () => {
    let installed = true
    const { space } = setup({
      ttsDiskReport: async () => ({ piper: { runtime: installed ? 5_000_000 : 0, voices: installed ? [{ id: "ugo", bytes: 1_000_000 }] : [] }, kokoro: 0 }),
      ttsPiperDelete: async () => {
        installed = false
        return 6_000_000
      },
    })
    await space.refresh()
    expect(ids(space.rows())).toContain("piper:ugo")
    await space.remove("piper:ugo")
    expect(ids(space.rows())).not.toContain("piper:ugo")
  })

  test("listeners hear every change, and stop hearing when they leave", async () => {
    const { space } = setup()
    let heard = 0
    const leave = space.onChange(() => void heard++)
    await space.refresh()
    expect(heard).toBeGreaterThan(0)
    const before = heard
    leave()
    await space.refresh()
    expect(heard).toBe(before)
  })
})

describe("the small things", () => {
  test("sizes read the way people read them", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(999)).toBe("999 B")
    expect(formatBytes(12_000)).toBe("12 KB")
    expect(formatBytes(3_400_000)).toBe("3.4 MB")
    expect(formatBytes(63_000_000)).toBe("63 MB")
    expect(formatBytes(2_500_000_000)).toBe("2.5 GB")
    expect(formatBytes(-1)).toBe("—")
    expect(formatBytes(Number.NaN)).toBe("—")
  })

  test("two spellings of a path are the same path", () => {
    expect(normalized("C:\\work\\app\\")).toBe("c:/work/app")
    expect(normalized("C:/work/app")).toBe("c:/work/app")
    expect(normalized("/home/u/app/")).toBe("/home/u/app")
  })

  test("git worktree list, block by block", () => {
    const listed = parseWorktrees(`${PORCELAIN}worktree C:/work/app-worktrees/lock\nbranch refs/heads/ade/lock\nlocked reason\n`)
    expect(listed.map((tree) => tree.path)).toEqual([ROOT, FIX, OLD, "C:/work/app-worktrees/lock"])
    expect(listed[1]).toEqual({ path: FIX, branch: "ade/fix", locked: false })
    expect(listed[3]!.locked).toBe(true)
    expect(parseWorktrees("")).toEqual([])
    expect(parseWorktrees("branch refs/heads/x\n")).toEqual([])
  })

  test("git branch --merged: plain names only", () => {
    expect(plainBranches("  ade/a\n* main\n+ ade/b\n\n  ade/c\n")).toEqual(["ade/a", "ade/c"])
    expect(plainBranches("")).toEqual([])
  })
})
