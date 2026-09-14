import { describe, expect, test } from "bun:test"
import { EXTERNAL_EDITORS, externalEditorUri } from "./external-editor"

describe("externalEditorUri", () => {
  test("builds a POSIX path", () => {
    expect(externalEditorUri({ editor: "vscode", path: "/home/me/app.ts" })).toBe("vscode://file/home/me/app.ts")
  })

  test("puts a Windows drive behind a leading slash, keeping its colon", () => {
    // `vscode://file/C:/x` is host `file`, path `/C:/x`. Encoding the colon to
    // `%3A` stops it being a drive and the editor opens nothing.
    expect(externalEditorUri({ editor: "cursor", path: String.raw`C:\Users\me\app.ts` })).toBe(
      "cursor://file/C:/Users/me/app.ts",
    )
  })

  test("accepts a Windows path already written with forward slashes", () => {
    expect(externalEditorUri({ editor: "zed", path: "C:/Users/me/app.ts" })).toBe("zed://file/C:/Users/me/app.ts")
  })

  test("survives a space and the other characters a path may carry", () => {
    const uri = externalEditorUri({ editor: "vscode", path: "/home/me/my project/a b.ts" })!
    expect(uri).toBe("vscode://file/home/me/my%20project/a%20b.ts")
    expect(uri).not.toContain(" ")
  })

  test("encodes a character that would end the URI early", () => {
    const uri = externalEditorUri({ editor: "vscode", path: "/home/me/a#b?c.ts" })!
    expect(uri).not.toContain("#")
    expect(uri).not.toContain("?")
  })

  test("appends a line when there is one", () => {
    expect(externalEditorUri({ editor: "vscode", path: "/a/b.ts", line: 42 })).toBe("vscode://file/a/b.ts:42")
  })

  test.each([0, -1, undefined])("does not append a line for %p", (line) => {
    expect(externalEditorUri({ editor: "vscode", path: "/a/b.ts", line })).toBe("vscode://file/a/b.ts")
  })

  test("truncates a fractional line rather than passing it on", () => {
    expect(externalEditorUri({ editor: "vscode", path: "/a/b.ts", line: 12.9 })).toBe("vscode://file/a/b.ts:12")
  })

  test("refuses a relative path instead of guessing", () => {
    // The editor would resolve it against its own working directory and open the
    // wrong file, or nothing, with nothing to tell the user which happened.
    expect(externalEditorUri({ editor: "vscode", path: "src/app.ts" })).toBeUndefined()
    expect(externalEditorUri({ editor: "vscode", path: "./app.ts" })).toBeUndefined()
    expect(externalEditorUri({ editor: "vscode", path: "../app.ts" })).toBeUndefined()
  })

  test("refuses an empty path", () => {
    expect(externalEditorUri({ editor: "vscode", path: "" })).toBeUndefined()
    expect(externalEditorUri({ editor: "vscode", path: "   " })).toBeUndefined()
  })

  test.each(EXTERNAL_EDITORS.map((editor) => editor.id))("%s gets its own scheme", (editor) => {
    const uri = externalEditorUri({ editor, path: "/a/b.ts" })!
    expect(uri.startsWith(`${editor}://file`)).toBe(true)
  })

  test("every listed editor has a label to show", () => {
    for (const editor of EXTERNAL_EDITORS) {
      expect(editor.label.trim().length).toBeGreaterThan(0)
    }
  })
})

describe("colons that are not drive letters", () => {
  test("a POSIX directory named like a drive keeps its colon encoded", () => {
    // Legal on Linux and macOS. Un-escaping it would make the editor read the
    // colon as the line-number separator.
    const uri = externalEditorUri({ editor: "vscode", path: "/home/me/c:/notes.md" })!
    expect(uri).toBe("vscode://file/home/me/c%3A/notes.md")
    expect(uri).not.toContain("/c:/")
  })

  test("a POSIX root directory named like a drive keeps its colon encoded", () => {
    // The un-escape is restricted to the drive segment of a Windows path, and
    // that segment is index 1 — the same index a POSIX path uses for its first
    // real directory. Only a path shaped like this can tell the two apart, so
    // without it the Windows guard could be dropped entirely and stay green.
    const uri = externalEditorUri({ editor: "vscode", path: "/c:/notes.md" })!
    expect(uri).toBe("vscode://file/c%3A/notes.md")
  })

  test("the Windows drive still survives", () => {
    expect(externalEditorUri({ editor: "vscode", path: String.raw`C:\a\b.ts` })).toBe("vscode://file/C:/a/b.ts")
  })

  test("a deeper segment on Windows that looks like a drive stays encoded", () => {
    const uri = externalEditorUri({ editor: "vscode", path: String.raw`C:\x\d:\f.ts` })!
    expect(uri).toBe("vscode://file/C:/x/d%3A/f.ts")
  })
})
