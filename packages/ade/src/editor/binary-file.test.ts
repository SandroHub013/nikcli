import { describe, expect, test } from "bun:test"
import { binaryType, formatSize } from "./binary-file"
import { translate } from "../i18n"

/*
 * The binary file card says what a file is and how big, in the interface's
 * language (pannello-file-binario, point 2). The user opened a 135800631-byte
 * APK and read only that number, raw.
 */

describe("formatSize", () => {
  test("a size reads in the unit a person would say, with the language's decimal mark", () => {
    expect(formatSize(135800631, "it")).toBe("129,5 MB")
    expect(formatSize(135800631, "en")).toBe("129.5 MB")
    expect(formatSize(1536, "it")).toBe("1,5 KB")
    expect(formatSize(3 * 1024 ** 3, "en")).toBe("3 GB")
  })

  test("a size that rounds up to the next unit is said in that unit", () => {
    expect(formatSize(1048575, "it")).toBe("1 MB")
    expect(formatSize(1024 ** 3 - 1, "en")).toBe("1 GB")
    expect(formatSize(1023 * 1024 + 1000, "en")).toBe("1 MB")
  })

  test("under a kilobyte the bytes are counted, in words", () => {
    expect(formatSize(5, "it")).toBe("5 byte")
    expect(formatSize(5, "en")).toBe("5 bytes")
    expect(formatSize(1, "en")).toBe("1 byte")
    expect(formatSize(0, "it")).toBe("0 byte")
  })
})

const PK = [0x50, 0x4b, 0x03, 0x04]
const MZ = [0x4d, 0x5a, 0x90, 0x00]

describe("binaryType", () => {
  test("a ZIP by its magic number is told apart by its extension", () => {
    expect(binaryType("Fabioland-0.1.1-preview.apk", PK)).toBe("apk")
    expect(binaryType("bundle.AAB", PK)).toBe("aab")
    expect(binaryType("lib.jar", PK)).toBe("jar")
    expect(binaryType("photos.zip", PK)).toBe("zip")
    // A ZIP whose name says nothing is still a ZIP.
    expect(binaryType("download", PK)).toBe("zip")
  })

  test("the magic number wins over a name that lies", () => {
    expect(binaryType("notes.zip", MZ)).toBe("exe")
    expect(binaryType("readme.apk", [0x25, 0x50, 0x44, 0x46])).toBe("pdf")
    expect(binaryType("helper.dll", MZ)).toBe("dll")
  })

  test("the other formats ADE knows by their first bytes", () => {
    expect(binaryType("x", [0x1f, 0x8b, 0x08])).toBe("gzip")
    expect(binaryType("x", [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])).toBe("7z")
    expect(binaryType("x", [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])).toBe("rar")
    expect(binaryType("x", [...new TextEncoder().encode("SQLite format 3"), 0])).toBe("sqlite")
    expect(binaryType("x", [0x00, 0x61, 0x73, 0x6d])).toBe("wasm")
    expect(binaryType("x", [0x7f, 0x45, 0x4c, 0x46])).toBe("elf")
  })

  test("without a known magic number the extension decides, and the fallback is a plain binary", () => {
    expect(binaryType("C:/a/b/app.apk", [])).toBe("apk")
    expect(binaryType("setup.exe", [0xff])).toBe("exe")
    expect(binaryType("data.bin", [0xff, 0xfe])).toBe("binary")
    expect(binaryType("noext", [])).toBe("binary")
  })

  test("every type has a name in both languages", () => {
    const types = ["apk", "aab", "jar", "zip", "exe", "dll", "pdf", "gzip", "7z", "rar", "sqlite", "wasm", "elf", "binary"]
    for (const type of types) {
      const key = `file.type.${type}` as never
      expect(translate("it", key)).not.toBe(translate("en", key))
    }
    expect(translate("it", "file.type.apk" as never)).toBe("Pacchetto Android (APK)")
    expect(translate("en", "file.type.apk" as never)).toBe("Android package (APK)")
  })
})
