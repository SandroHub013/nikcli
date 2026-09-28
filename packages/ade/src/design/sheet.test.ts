import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { DirEntry } from "../host/shell"
import {
  SHEET_RELOAD_DELAY_MS,
  SHEET_TITLE_MAX,
  createSheetWatch,
  isSheetAddress,
  sheetChanged,
  sheetFolder,
  sheetLabel,
  sheetName,
  sheetPaneFor,
  sheetTitle,
  sheetUrl,
} from "./sheet"

/*
 * The design sheet, piece 1 (`ade-msg design`): what the pane does with a file
 * Rust already accepted. The checks on the path are `media.rs`'s own tests.
 */

const FILE = "C:/p/.ade/design/menu.html"

describe("the sheet's title", () => {
  test("one line of plain text: escapes and breaks become spaces", () => {
    expect(sheetTitle("  Menu\u001b[31m rosso\r\nsecondo  ")).toBe("Menu [31m rosso secondo")
  })

  test("cut at the limit, and nothing is no title", () => {
    const long = "x".repeat(SHEET_TITLE_MAX + 20)
    expect(sheetTitle(long)).toHaveLength(SHEET_TITLE_MAX)
    expect(sheetTitle(long)?.endsWith("…")).toBe(true)
    expect(sheetTitle("  \u0007 ")).toBeUndefined()
    expect(sheetTitle(undefined)).toBeUndefined()
  })

  test("the pane is called by its title, or by the file's name", () => {
    expect(sheetLabel({ file: FILE, title: "Menu" })).toBe("Menu")
    expect(sheetLabel({ file: "C:\\p\\.ade\\design\\menu.html" })).toBe("menu.html")
    expect(sheetName(FILE)).toBe("menu.html")
    expect(sheetFolder(FILE)).toBe("C:/p/.ade/design")
    expect(sheetFolder("C:\\p\\.ade\\design\\menu.html")).toBe("C:\\p\\.ade\\design")
  })
})

describe("the sheet's address", () => {
  test("the file on ade-media, in the spelling of each platform", () => {
    expect(sheetUrl(FILE, true)).toBe("http://ade-media.localhost/C%3A/p/.ade/design/menu.html")
    expect(sheetUrl(FILE, false)).toBe("ade-media://localhost/C%3A/p/.ade/design/menu.html")
  })

  test("only that file passes: a reload's query does, another path does not", () => {
    const url = sheetUrl(FILE, true)
    expect(isSheetAddress(url, FILE, true)).toBe(true)
    expect(isSheetAddress(`${url}?__ade_reload=3`, FILE, true)).toBe(true)
    expect(isSheetAddress(`${url}#fondo`, FILE, true)).toBe(true)
    expect(isSheetAddress(sheetUrl("C:/p/.env", true), FILE, true)).toBe(false)
    expect(isSheetAddress(`${url}.bak`, FILE, true)).toBe(false)
    expect(isSheetAddress(sheetUrl("C:/p/.ade/design/altro.html", true), FILE, true)).toBe(false)
    expect(isSheetAddress("http://localhost:3000/", FILE, true)).toBe(false)
  })
})

describe("one pane per sheet", () => {
  const panes = [{ id: "b1" }, { id: "b2", designSheet: { file: "C:\\P\\.ade\\design\\Menu.html", from: "n1-0" } }]

  test("the same file, however spelled, finds the pane that shows it", () => {
    expect(sheetPaneFor(panes, FILE)?.id).toBe("b2")
  })

  test("another file finds none", () => {
    expect(sheetPaneFor(panes, "C:/p/.ade/design/altro.html")).toBeUndefined()
  })
})

describe("the reload", () => {
  const entry = (name: string, modified_ms: number, size: number): DirEntry => ({
    name,
    path: `C:/p/.ade/design/${name}`,
    is_dir: false,
    size,
    modified_ms,
  })

  test("a change is a new size or a new write; the first sight and a missing file are not", () => {
    expect(sheetChanged(undefined, { modified_ms: 1, size: 1 })).toBe(false)
    expect(sheetChanged({ modified: 1, size: 1 }, undefined)).toBe(false)
    expect(sheetChanged({ modified: 1, size: 1 }, { modified_ms: 1, size: 1 })).toBe(false)
    expect(sheetChanged({ modified: 1, size: 1 }, { modified_ms: 2, size: 1 })).toBe(true)
    expect(sheetChanged({ modified: 1, size: 1 }, { modified_ms: 1, size: 2 })).toBe(true)
  })

  const setup = (sheets: { id: string; file: string }[]) => {
    const reloaded: string[] = []
    const timers: { run: () => void; ms: number; cancelled: boolean }[] = []
    let listing: DirEntry[] = []
    const listed: string[] = []
    const watch = createSheetWatch({
      sheets: () => sheets,
      reload: (id) => reloaded.push(id),
      later: (run, ms) => {
        const timer = { run, ms, cancelled: false }
        timers.push(timer)
        return timer
      },
      cancel: (handle) => {
        ;(handle as { cancelled: boolean }).cancelled = true
      },
    })
    const readDir = async (dir: string) => {
      listed.push(dir)
      return listing
    }
    const fire = () => {
      for (const timer of timers.splice(0)) if (!timer.cancelled) timer.run()
    }
    return {
      watch,
      reloaded,
      timers,
      listed,
      fire,
      readDir,
      set: (entries: DirEntry[]) => {
        listing = entries
      },
    }
  }

  test("a new modified_ms reloads the pane, after the delay", async () => {
    const t = setup([{ id: "b1", file: FILE }])
    t.set([entry("menu.html", 100, 10)])
    await t.watch.tick(t.readDir)
    expect(t.timers).toHaveLength(0)
    t.set([entry("menu.html", 200, 10)])
    await t.watch.tick(t.readDir)
    expect(t.timers.map((timer) => timer.ms)).toEqual([SHEET_RELOAD_DELAY_MS])
    expect(t.reloaded).toEqual([])
    t.fire()
    expect(t.reloaded).toEqual(["b1"])
    expect(t.listed).toEqual(["C:/p/.ade/design", "C:/p/.ade/design"])
  })

  test("an unchanged file, another file's change and a vanished file reload nothing", async () => {
    const t = setup([{ id: "b1", file: FILE }])
    t.set([entry("menu.html", 100, 10), entry("altro.html", 1, 1)])
    await t.watch.tick(t.readDir)
    t.set([entry("menu.html", 100, 10), entry("altro.html", 2, 2)])
    await t.watch.tick(t.readDir)
    t.set([])
    await t.watch.tick(t.readDir)
    t.fire()
    expect(t.reloaded).toEqual([])
  })

  test("two writes in a row load the frame once, after the last", async () => {
    const t = setup([{ id: "b1", file: FILE }])
    t.set([entry("menu.html", 100, 10)])
    await t.watch.tick(t.readDir)
    t.set([entry("menu.html", 200, 10)])
    await t.watch.tick(t.readDir)
    t.set([entry("menu.html", 300, 12)])
    await t.watch.tick(t.readDir)
    expect(t.timers.map((timer) => timer.cancelled)).toEqual([true, false])
    t.fire()
    expect(t.reloaded).toEqual(["b1"])
  })

  test("a closed pane's reload is cancelled", async () => {
    const t = setup([{ id: "b1", file: FILE }])
    t.set([entry("menu.html", 100, 10)])
    await t.watch.tick(t.readDir)
    t.set([entry("menu.html", 200, 10)])
    await t.watch.tick(t.readDir)
    t.watch.forget("b1")
    t.fire()
    expect(t.reloaded).toEqual([])
  })

  test("with no listing there is nothing to read", async () => {
    const t = setup([{ id: "b1", file: FILE }])
    await t.watch.tick(undefined)
    expect(t.listed).toEqual([])
  })
})

describe("the workbench and the pane", () => {
  const src = join(import.meta.dir, "..")
  const read = (path: string) => readFileSync(join(src, path), "utf8")

  test("lint: design is handled before a target is resolved, and the same file reuses its pane", () => {
    const workbench = read("surface/workbench.tsx")
    const design = workbench.indexOf('if (message.kind === "design") {')
    const resolve = workbench.indexOf("const target = resolveTarget(panes, message.to, message.from)")
    expect(design).toBeGreaterThan(0)
    expect(design).toBeLessThan(resolve)
    const handler = workbench.slice(design, resolve)
    expect(handler).toContain("host.designSheetPath(message.path, cwd)")
    expect(handler).toContain("sheetPaneFor(wb().panes, file)")
    expect(handler).toContain("!running.has(from.id)")
  })

  test("lint: the sheets' reload rides the registers' pass", () => {
    expect(read("surface/workbench.tsx")).toContain("watchRegisters([decisionsRegister, designRegister, sheetWatch]")
  })
})
