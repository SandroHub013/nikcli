import { describe, expect, it } from "bun:test"
import { Patch } from "@/patch"

const FILE = ["def greet():", '    print("Hi")', "", "def bye():", '    print("Bye")', ""].join("\n")

function apply(patch: string, content = FILE) {
  const { hunks } = Patch.parsePatch(patch)
  const hunk = hunks[0]
  if (hunk?.type !== "update") throw new Error("expected an update hunk")
  return Patch.deriveNewContentsFromChunks("x.py", hunk.chunks, content).content
}

const wrap = (body: string) => `*** Begin Patch\n*** Update File: x.py\n${body}\n*** End Patch`

describe("apply_patch tolerates the usual model habits", () => {
  it("reads a blank line written as an empty line inside a hunk as a blank context line", () => {
    const out = apply(wrap(['@@ def greet():', '-    print("Hi")', '+    print("Hello")', "", " def bye():"].join("\n")))
    expect(out).toContain('    print("Hello")\n\ndef bye():')
  })

  it("drops empty lines at the end of a hunk instead of requiring them", () => {
    const out = apply(wrap(["@@ def greet():", '-    print("Hi")', '+    print("Hello")', "", "@@ def bye():", '-    print("Bye")', '+    print("Goodbye")'].join("\n")))
    expect(out).toContain('print("Goodbye")')
    expect(out).toContain('print("Hello")')
  })

  it("takes a numbered unified header as no anchor, and keeps the text after it as the anchor", () => {
    const bare = Patch.parsePatch(wrap(["@@ -1,3 +1,3 @@", '-    print("Hi")', '+    print("Hello")'].join("\n")))
    const withText = Patch.parsePatch(wrap(["@@ -1,3 +1,3 @@ def greet():", '-    print("Hi")', '+    print("Hello")'].join("\n")))
    const chunk = (p: ReturnType<typeof Patch.parsePatch>) => (p.hunks[0] as Extract<Patch.Hunk, { type: "update" }>).chunks[0]
    expect(chunk(bare)?.change_context).toBeUndefined()
    expect(chunk(withText)?.change_context).toBe("def greet():")
    expect(apply(wrap(["@@ -1,3 +1,3 @@ def greet():", '-    print("Hi")', '+    print("Hello")'].join("\n")))).toContain('print("Hello")')
  })

  it("matches when only whitespace inside the line differs", () => {
    const out = apply(wrap(["@@", '-def   greet():', "+def greet(name):"].join("\n")))
    expect(out.startsWith("def greet(name):")).toBe(true)
  })

  it("matches when the file has blank lines the hunk left out", () => {
    const out = apply(wrap(["@@", '-    print("Hi")', "-def bye():", "+def goodbye():"].join("\n")))
    expect(out).toContain("def goodbye():")
    expect(out).not.toContain("def bye():")
  })
})

describe("apply_patch error on a hunk that matches nowhere", () => {
  it("shows the closest stretch of the file as it is now, with line numbers and the first line that does not fit", () => {
    let message = ""
    try {
      apply(wrap(["@@", " def greet():", '-    print("Hello")', '+    print("Hey")'].join("\n")))
    } catch (error) {
      message = String(error)
    }
    expect(message).toContain("Failed to find expected lines in x.py")
    expect(message).toContain("Closest match")
    expect(message).toContain('Hunk line 2 is "    print(\\"Hello\\")" but file line 2 is "    print(\\"Hi\\")"')
    expect(message).toContain('2|     print("Hi")')
  })

  it("says so when no line of the hunk is in the file", () => {
    let message = ""
    try {
      apply(wrap(["@@", "-nothing like it", "+x"].join("\n")))
    } catch (error) {
      message = String(error)
    }
    expect(message).toContain("No line of the hunk occurs in the file")
  })
})
