import { describe, expect, test } from "bun:test"
import { t } from "../i18n"
import { MODEL_EXTENSIONS } from "../model3d/model"
import { PLAYABLE_EXTENSIONS } from "../video/video"
import {
  createOutsideConfirmationTracker,
  linkPlacement,
  openMarkdownFileLink,
  openPathLink,
  paneShowing,
  readsText,
  routeForFile,
  viewKind,
  type PathLinkDeps,
} from "./open-route"

describe("routeForFile", () => {
  test("every format the video panel plays opens a video panel, whatever the case or folder", () => {
    for (const extension of PLAYABLE_EXTENSIONS) {
      expect(`${extension}: ${routeForFile(`C:\\progetto\\video\\demo.${extension}`)}`).toBe(`${extension}: video`)
      expect(`${extension}: ${routeForFile(`/home/me/clip.${extension.toUpperCase()}`)}`).toBe(`${extension}: video`)
    }
    expect(routeForFile("registrazioni/ADE 2026-09-16.mp4")).toBe("video")
  })

  test("models still open the 3D panel", () => {
    for (const extension of MODEL_EXTENSIONS) expect(routeForFile(`assets/robot.${extension}`)).toBe("model")
  })

  test("everything else opens the editor, formats the panel cannot play included", () => {
    for (const path of ["src/index.ts", "README.md", "film.mkv", "film.avi", "mp4", "note.mp4.txt", "Makefile"]) {
      expect(`${path}: ${routeForFile(path)}`).toBe(`${path}: editor`)
    }
  })
})

describe("paneShowing", () => {
  const panes = [
    { id: "v1", mode: "video", videoPath: "C:\\Progetto\\video\\Demo.mp4" },
    { id: "v2", mode: "video", videoPath: "" },
    { id: "m1", mode: "model", modelPath: "C:/Progetto/assets/robot.glb" },
  ]

  test("finds the pane on the same file spelled with other case or separators", () => {
    expect(paneShowing(panes, "video", "c:/progetto/video/demo.mp4")?.id).toBe("v1")
    expect(paneShowing(panes, "model", "C:\\progetto\\assets\\ROBOT.glb")?.id).toBe("m1")
  })

  test("an empty pane, another file or the other panel is not a match", () => {
    expect(paneShowing(panes, "video", "")).toBeUndefined()
    expect(paneShowing(panes, "video", "C:/Progetto/video/altro.mp4")).toBeUndefined()
    expect(paneShowing(panes, "video", "C:/Progetto/assets/robot.glb")).toBeUndefined()
  })
})

describe("viewKind (S56)", () => {
  const table: Record<string, string[]> = {
    svg: ["svg"],
    image: ["png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "avif"],
    markdown: ["md", "markdown"],
    font: ["woff2", "woff", "ttf", "otf"],
    audio: ["aac", "mp3", "m4a", "wav", "oga", "opus"],
  }

  for (const [kind, extensions] of Object.entries(table)) {
    test(`${kind}: ${extensions.join(", ")}, in any case`, () => {
      for (const extension of extensions) {
        expect(viewKind(`C:/p/file.${extension}`)).toBe(kind as ReturnType<typeof viewKind>)
        expect(viewKind(String.raw`C:\p\FILE.` + extension.toUpperCase())).toBe(kind as ReturnType<typeof viewKind>)
      }
    })
  }

  test("everything else is text: .txt, .json, no extension, a dotfile", () => {
    expect(viewKind("notes.txt")).toBe("text")
    expect(viewKind("package.json")).toBe("text")
    expect(viewKind("C:/p/Makefile")).toBe("text")
    expect(viewKind("C:/p/.svg")).toBe("text")
    expect(viewKind("C:/p.md/README")).toBe("text")
  })

  test("only SVG, markdown and text are read as text", () => {
    expect(["svg", "markdown", "text"].every((kind) => readsText(kind as never))).toBe(true)
    expect(["image", "font", "audio"].some((kind) => readsText(kind as never))).toBe(false)
  })
})

describe("a file:line clicked in a session (S56, S76's low)", () => {
  /** A disk where a text file reads, a binary one exists but fails as binary, and anything else is missing. */
  const disk = (files: Record<string, "text" | "binary">) => {
    const opened: Array<[string, number | undefined]> = []
    const missing: string[] = []
    const deps = {
      readTextFile: async (path: string) => {
        if (files[path] === "text") return { text: "x", truncated: true }
        throw new Error(files[path] === "binary" ? "file binario, 5 byte" : "impossibile trovare il file")
      },
      open: (path: string, line?: number) => void opened.push([path, line]),
      say: (path: string) => void missing.push(path),
    }
    return { deps, opened, missing }
  }

  test("a link to an existing png opens its pane and does not say «File non trovato»", async () => {
    const { deps, opened, missing } = disk({ "C:/p/img/logo.png": "binary" })
    await openPathLink("img/logo.png", "C:/p", undefined, deps)
    expect(missing).toEqual([])
    expect(opened).toEqual([["C:/p/img/logo.png", undefined]])
  })

  test("a font, a sound and an mp4 go to their pane without the text check", async () => {
    const { deps, opened, missing } = disk({ "C:/p/a.woff2": "binary", "C:/p/a.aac": "binary", "C:/p/a.mp4": "binary" })
    for (const name of ["a.woff2", "a.aac", "a.mp4"]) await openPathLink(name, "C:/p", undefined, deps)
    expect(missing).toEqual([])
    expect(opened.map(([path]) => path)).toEqual(["C:/p/a.woff2", "C:/p/a.aac", "C:/p/a.mp4"])
  })

  test("a text file is still checked: there, at its line; missing, said so", async () => {
    const { deps, opened, missing } = disk({ "C:/p/src/a.ts": "text" })
    await openPathLink("./src/a.ts", "C:/p/", 12, deps)
    await openPathLink("src/b.ts", "C:/p", 3, deps)
    expect(opened).toEqual([["C:/p/src/a.ts", 12]])
    expect(missing).toEqual(["C:/p/src/b.ts"])
  })
})

describe("linkPlacement", () => {
  const roots = ["C:/project", "D:/second-repo"]

  test("UNC paths are classified as unc (\\\\, //, \\\\?\\, decoded %5C%5C and %2F%2F)", () => {
    expect(linkPlacement("\\\\server\\share\\file.txt", roots)).toBe("unc")
    expect(linkPlacement("//server/share/file.txt", roots)).toBe("unc")
    expect(linkPlacement("\\\\?\\C:\\repo\\file.txt", roots)).toBe("unc")
    expect(linkPlacement("\\\\.\\pipe\\test", roots)).toBe("unc")
    expect(linkPlacement("%5C%5Cserver%5Cshare%5Cfile.txt", roots)).toBe("unc")
    expect(linkPlacement("%2F%2Fserver%2Fshare%2Ffile.txt", roots)).toBe("unc")
  })

  test("paths inside the roots are classified as inside", () => {
    expect(linkPlacement("C:/project/src/index.ts", roots)).toBe("inside")
    expect(linkPlacement("C:/project", roots)).toBe("inside")
    expect(linkPlacement("C:/project/", roots)).toBe("inside")
    expect(linkPlacement("C:\\project\\src\\index.ts", roots)).toBe("inside")
    expect(linkPlacement("C:/project/sub/../src/index.ts", roots)).toBe("inside")
    expect(linkPlacement("D:/second-repo/pkg/main.go", roots)).toBe("inside")
  })

  test("Windows paths match roots case-insensitively", () => {
    expect(linkPlacement("c:/project/src/index.ts", roots)).toBe("inside")
    expect(linkPlacement("C:/PROJECT/SRC/INDEX.TS", roots)).toBe("inside")
    expect(linkPlacement("c:/PROJECT/src/file.ts", ["C:/Project"])).toBe("inside")
    expect(linkPlacement("C:/Project/file.ts", ["c:/project"])).toBe("inside")
  })

  test("paths outside the roots are classified as outside", () => {
    expect(linkPlacement("../../.ssh/id_rsa", roots)).toBe("outside")
    expect(linkPlacement("C:/project/../../.ssh/id_rsa", roots)).toBe("outside")
    expect(linkPlacement("C:/Users/alice/.ssh/id_rsa", roots)).toBe("outside")
    expect(linkPlacement("C:/other-project/file.ts", roots)).toBe("outside")
    expect(linkPlacement("C:/project-two/file.ts", roots)).toBe("outside")
    expect(linkPlacement("E:/somewhere/else.txt", roots)).toBe("outside")
    expect(linkPlacement("C:/project/file.ts", [])).toBe("outside")
  })
})

describe("markdown file links (openMarkdownFileLink)", () => {
  const roots = ["C:/project"]

  test("inside paths open immediately and emit no note", () => {
    const opened: string[] = []
    const notes: string[] = []
    const result = openMarkdownFileLink("C:/project/docs/readme.md", roots, {
      open: (p) => opened.push(p),
      say: (n) => notes.push(n),
    })
    expect(result).toBe(true)
    expect(opened).toEqual(["C:/project/docs/readme.md"])
    expect(notes).toEqual([])
  })

  test("outside paths do not open and emit «fuori dal progetto» note", () => {
    const opened: string[] = []
    const notes: string[] = []
    const result = openMarkdownFileLink("C:/Users/alice/.ssh/id_rsa", roots, {
      open: (p) => opened.push(p),
      say: (n) => notes.push(n),
    })
    expect(result).toBe(false)
    expect(opened).toEqual([])
    expect(notes).toEqual([t("pane.link.outside")])
  })

  test("UNC paths do not open and emit «percorso di rete non aperto» note", () => {
    const opened: string[] = []
    const notes: string[] = []
    const result = openMarkdownFileLink("\\\\host\\share\\doc.md", roots, {
      open: (p) => opened.push(p),
      say: (n) => notes.push(n),
    })
    expect(result).toBe(false)
    expect(opened).toEqual([])
    expect(notes).toEqual([t("pane.link.unc")])
  })
})

describe("terminal links (openPathLink with roots and outside confirmation)", () => {
  const roots = ["C:/project"]

  const createTestContext = () => {
    const opened: Array<[string, number | undefined]> = []
    const notes: string[] = []
    const tracker = createOutsideConfirmationTracker(5000)
    const deps: PathLinkDeps = {
      readTextFile: async () => ({ text: "ok" }),
      open: (path, line) => opened.push([path, line]),
      say: (note) => notes.push(note),
      sayNote: (note) => notes.push(note),
      roots,
      confirmOutside: (path) => tracker.checkAndRecord(path),
    }
    return { opened, notes, tracker, deps }
  }

  test("inside link opens on first click without confirmation", async () => {
    const { deps, opened, notes } = createTestContext()
    const result = await openPathLink("src/index.ts", "C:/project", 42, deps)
    expect(result).toBe(true)
    expect(opened).toEqual([["C:/project/src/index.ts", 42]])
    expect(notes).toEqual([])
  })

  test("outside link does not open on 1st click and prompts confirmation; opens on 2nd click within 5s", async () => {
    const { deps, opened, notes } = createTestContext()

    // 1st click: prompts confirmation
    const firstResult = await openPathLink("../../.ssh/id_rsa", "C:/project", undefined, deps)
    expect(firstResult).toBe(false)
    expect(opened).toEqual([])
    expect(notes).toEqual([t("pane.link.outsideConfirm")])

    // 2nd click: opens outside file
    const secondResult = await openPathLink("../../.ssh/id_rsa", "C:/project", undefined, deps)
    expect(secondResult).toBe(true)
    expect(opened).toEqual([["C:/project/../../.ssh/id_rsa", undefined]])
    expect(notes).toEqual([t("pane.link.outsideConfirm")])
  })

  test("outside link does not open on 2nd click if more than 5s elapsed", async () => {
    const opened: Array<[string, number | undefined]> = []
    const notes: string[] = []
    const tracker = createOutsideConfirmationTracker(5000)
    let fakeNow = 1000
    const deps: PathLinkDeps = {
      readTextFile: async () => ({ text: "ok" }),
      open: (path, line) => opened.push([path, line]),
      say: (note) => notes.push(note),
      sayNote: (note) => notes.push(note),
      roots,
      confirmOutside: (path) => tracker.checkAndRecord(path, fakeNow),
    }

    // 1st click at t=1000
    const firstResult = await openPathLink("C:/other/file.txt", undefined, undefined, deps)
    expect(firstResult).toBe(false)
    expect(opened).toEqual([])
    expect(notes).toEqual([t("pane.link.outsideConfirm")])

    // 2nd click at t=7000 (> 5000ms later): does not open, asks confirmation again
    fakeNow = 7000
    const secondResult = await openPathLink("C:/other/file.txt", undefined, undefined, deps)
    expect(secondResult).toBe(false)
    expect(opened).toEqual([])
    expect(notes).toEqual([t("pane.link.outsideConfirm"), t("pane.link.outsideConfirm")])
  })

  test("UNC link does not open from terminal and emits «percorso di rete non aperto» note", async () => {
    const { deps, opened, notes } = createTestContext()
    const uncBackslash = await openPathLink("\\\\server\\share\\file.txt", "C:/project", undefined, deps)
    expect(uncBackslash).toBe(false)
    expect(opened).toEqual([])
    expect(notes).toEqual([t("pane.link.unc")])

    const uncSlash = await openPathLink("//server/share/file.txt", "C:/project", undefined, deps)
    expect(uncSlash).toBe(false)
    expect(opened).toEqual([])
    expect(notes).toEqual([t("pane.link.unc"), t("pane.link.unc")])
  })
})

