import { describe, expect, it } from "bun:test"
import { normalizeToolPath, resolveWorkdir } from "@/tool/tool-path"

const root = "C:\\work\\proj"
const exists = (...present: string[]) => (target: string) => present.map((p) => p.toLowerCase()).includes(target.toLowerCase())

describe("normalizeToolPath on Windows", () => {
  const win = (present: string[] = []) => ({ platform: "win32" as const, exists: exists(...present) })

  it("reads /c/x (Git Bash) and /C:/x (URL form) as C:\\x", () => {
    expect(normalizeToolPath("/c/sbx/a.py", root, win())).toBe("C:\\sbx\\a.py")
    expect(normalizeToolPath("/C/sbx/a.py", root, win())).toBe("C:\\sbx\\a.py")
    expect(normalizeToolPath("/C:/sbx/a.py", root, win())).toBe("C:\\sbx\\a.py")
    expect(normalizeToolPath("//c:/sbx/a.py", root, win())).toBe("C:\\sbx\\a.py")
    expect(normalizeToolPath("/c", root, win())).toBe("C:\\")
  })

  it("leaves a real absolute path alone", () => {
    expect(normalizeToolPath("D:\\data\\a.py", root, win(["D:\\data\\a.py"]))).toBe("D:\\data\\a.py")
    expect(normalizeToolPath("C:/work/proj/a.py", root, win())).toBe("C:\\work\\proj\\a.py")
  })

  it("points /src/x at the project when the project has src and the drive root has no such path", () => {
    expect(normalizeToolPath("/src/x.py", root, win(["C:\\work\\proj\\src"]))).toBe("C:\\work\\proj\\src\\x.py")
    expect(normalizeToolPath("C:\\src\\x.py", root, win(["C:\\work\\proj\\src"]))).toBe("C:\\work\\proj\\src\\x.py")
  })

  it("keeps /src/x when it really exists, or when the project has no src", () => {
    expect(normalizeToolPath("/src/x.py", root, win(["C:\\src\\x.py", "C:\\work\\proj\\src"]))).toBe("C:\\src\\x.py")
    expect(normalizeToolPath("/lib/x.py", root, win(["C:\\work\\proj\\src"]))).toBe("C:\\lib\\x.py")
  })

  it("resolves a relative path against the project and strips quotes", () => {
    expect(normalizeToolPath("src/x.py", root, win())).toBe("C:\\work\\proj\\src\\x.py")
    expect(normalizeToolPath('"src/x.py"', root, win())).toBe("C:\\work\\proj\\src\\x.py")
    expect(normalizeToolPath("  ", root, win())).toBe(root)
  })
})

describe("normalizeToolPath on POSIX", () => {
  const posix = (present: string[] = []) => ({ platform: "linux" as const, exists: exists(...present) })

  it("does not read /c/x as a drive", () => {
    expect(normalizeToolPath("/c/sbx/a.py", "/work/proj", posix(["/c/sbx/a.py"]))).toBe("/c/sbx/a.py")
  })

  it("points /src/x at the project when it is not there but the project has src", () => {
    expect(normalizeToolPath("/src/x.py", "/work/proj", posix(["/work/proj/src"]))).toBe("/work/proj/src/x.py")
  })
})

describe("resolveWorkdir", () => {
  const dirs = (...present: string[]) => (target: string) => present.map((p) => p.toLowerCase()).includes(target.toLowerCase())
  const win = (present: string[]) => ({ platform: "win32" as const, exists: exists(...present), isDirectory: dirs(...present) })
  const posix = (present: string[]) => ({ platform: "linux" as const, exists: exists(...present), isDirectory: dirs(...present) })

  it("reads an MSYS workdir as the drive path", () => {
    expect(resolveWorkdir("/c/sbx/ws", root, win(["C:\\sbx\\ws"]))).toBe("C:\\sbx\\ws")
  })

  it("resolves a relative workdir against the project", () => {
    expect(resolveWorkdir("src", root, win(["C:\\work\\proj\\src"]))).toBe("C:\\work\\proj\\src")
  })

  it("names the resolved path and the given one when the directory is missing", () => {
    expect(() => resolveWorkdir("/c/sbx/missing", root, win([]))).toThrow(
      'workdir does not exist: C:\\sbx\\missing (from "/c/sbx/missing")',
    )
  })

  it("does not read /c/x as a drive on POSIX", () => {
    expect(resolveWorkdir("/c/sbx", "/work/proj", posix(["/c/sbx"]))).toBe("/c/sbx")
    expect(() => resolveWorkdir("/c/nope", "/work/proj", posix([]))).toThrow("workdir does not exist: /c/nope")
  })
})
