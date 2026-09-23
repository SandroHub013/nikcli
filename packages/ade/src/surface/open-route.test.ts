import { describe, expect, test } from "bun:test"
import { MODEL_EXTENSIONS } from "../model3d/model"
import { PLAYABLE_EXTENSIONS } from "../video/video"
import { openPathLink, paneShowing, readsText, routeForFile, viewKind } from "./open-route"

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
