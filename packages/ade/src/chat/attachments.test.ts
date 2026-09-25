import { describe, expect, test } from "bun:test"
import {
  addAttachment,
  attachmentFor,
  attachmentParts,
  completeMention,
  fileUrl,
  insideProject,
  mentionAt,
  mimeOf,
  pathOfFileUrl,
} from "./attachments"

/* C6: the chat attaches only files of the project it is admitted to. */

const ROOT = "C:\\Progetti\\app"

describe("a file of the project, and nothing else", () => {
  test("inside: absolute, relative, in any case or slash", () => {
    expect(insideProject(ROOT, "C:\\Progetti\\app\\src\\a.ts")).toBe("C:/Progetti/app/src/a.ts")
    expect(insideProject(ROOT, "c:/progetti/APP/src/a.ts")).toBe("c:/progetti/APP/src/a.ts")
    expect(insideProject(ROOT, "src/b.ts")).toBe("C:/Progetti/app/src/b.ts")
    expect(insideProject(ROOT, "./src/../README.md")).toBe("C:/Progetti/app/README.md")
    expect(insideProject("/home/u/app/", "/home/u/app/x.ts")).toBe("/home/u/app/x.ts")
  })

  test("outside: up with .., a sibling with the same prefix, another drive, UNC, device paths, the folder itself", () => {
    for (const path of [
      "..\\secret.txt",
      "src/../../secret.txt",
      "C:\\Progetti\\app\\..\\altro\\x.ts",
      "C:\\Progetti\\app-vecchia\\x.ts",
      "C:\\Users\\me\\.ssh\\id_ed25519",
      "D:\\Progetti\\app\\x.ts",
      "\\\\server\\share\\x.ts",
      "\\\\?\\C:\\Progetti\\app\\x.ts",
      "//server/share/x.ts",
      "C:x.ts",
      "C:\\Progetti\\app",
      "C:\\Progetti\\app\\",
      "",
    ]) {
      expect([path, insideProject(ROOT, path)]).toEqual([path, undefined])
    }
    expect(insideProject("/home/u/app", "/etc/passwd")).toBeUndefined()
    expect(insideProject("", "a.ts")).toBeUndefined()
  })

  test("an attachment knows its place in the project and its kind", () => {
    expect(attachmentFor(ROOT, "C:\\Progetti\\app\\docs\\schema.png")).toEqual({
      path: "C:/Progetti/app/docs/schema.png",
      relative: "docs/schema.png",
      mime: "image/png",
    })
    expect(attachmentFor(ROOT, "D:\\x.ts")).toBeUndefined()
    expect(mimeOf("a.PDF")).toBe("application/pdf")
    expect(mimeOf("a.ts")).toBe("text/plain")
    expect(mimeOf("Makefile")).toBe("text/plain")
  })

  test("the part nikcli receives: a file:// URL it reads back to the same path", () => {
    const attachment = attachmentFor(ROOT, "src/con spazio #1.ts")!
    const [part] = attachmentParts([attachment])
    expect(part).toEqual({
      type: "file",
      mime: "text/plain",
      url: "file:///C:/Progetti/app/src/con%20spazio%20%231.ts",
      filename: "con spazio #1.ts",
    })
    expect(pathOfFileUrl(part!.url)).toBe("C:/Progetti/app/src/con spazio #1.ts")
    expect(fileUrl("/home/u/a b.ts")).toBe("file:///home/u/a%20b.ts")
    expect(pathOfFileUrl("file:///home/u/a%20b.ts")).toBe("/home/u/a b.ts")
    expect(pathOfFileUrl("https://x.test/a")).toBeUndefined()
    // A host in the URL is a share on another machine.
    expect(pathOfFileUrl("file://server/share/x.ts")).toBeUndefined()
  })

  test("the same file twice is one attachment", () => {
    const a = attachmentFor(ROOT, "src/a.ts")!
    const again = attachmentFor(ROOT, "C:/PROGETTI/app/src/a.ts")!
    expect(addAttachment(addAttachment([], a), again)).toEqual([a])
  })
})

describe("@ in the composer", () => {
  test("the word being typed after an @ is the query; an e-mail or a finished word is not", () => {
    expect(mentionAt("guarda @src/ap", 14)).toEqual({ start: 7, query: "src/ap" })
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" })
    expect(mentionAt("scrivi a me@example.com", 23)).toBeUndefined()
    expect(mentionAt("guarda @src/app.ts e poi", 24)).toBeUndefined()
  })

  test("choosing a file puts its path in the text and the caret after it", () => {
    expect(completeMention("@a", { start: 0 }, 2, "a.ts")).toEqual({ text: "@a.ts ", caret: 6 })
    const text = "guarda @src/ap per favore"
    const mention = mentionAt(text, 14)!
    expect(completeMention(text, mention, 14, "src/app.ts")).toEqual({
      text: "guarda @src/app.ts per favore",
      caret: 19,
    })
  })
})
