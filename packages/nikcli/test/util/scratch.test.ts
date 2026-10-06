import { describe, expect, it } from "bun:test"
import os from "os"
import path from "path"
import { notFoundMessage, scratchEnvLine, scratchHint, withScratchHint } from "@/util/scratch"

/**
 * Measured in the `bunny-p5` sweep: 9 of nikcli's 16 failed calls were `write`
 * to a `%TEMP%` path with somebody else's user in it. Each one cost a turn to
 * learn nothing the prompt could have said up front.
 */
describe("scratch env line", () => {
  it("names the real temp dir", () => {
    expect(scratchEnvLine()).toBe(`  Temp dir: ${os.tmpdir()} (scratch files)`)
  })

  it("stays one line and short — it is paid at every request", () => {
    const line = scratchEnvLine()
    expect(line).not.toContain("\n")
    // The machine-specific half is the path; this bounds the text around it.
    expect(line.replace(os.tmpdir(), "")).toHaveLength("  Temp dir:  (scratch files)".length)
  })
})

describe("withScratchHint", () => {
  // Deliberately not under the temp dir: "no hint" is then observable.
  const directory = path.join(path.sep, "srv", "nikcli-project")

  it("appends the two paths that work to a path failure", () => {
    const failure = Object.assign(new Error("EPERM: operation not permitted, mkdir 'C:\\nope'"), {
      code: "EPERM",
    })
    const annotated = withScratchHint(failure, directory)
    expect(annotated.message).toContain("EPERM: operation not permitted")
    expect(annotated.message).toContain(os.tmpdir())
    expect(annotated.message).toContain(directory)
  })

  it("keeps the original error as the cause", () => {
    const failure = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
    expect(withScratchHint(failure, directory).cause).toBe(failure)
  })

  it("recognises the code from the message when the error carries none", () => {
    // Bun wraps some failures and drops `code`; the message still names it.
    const wrapped = new Error("ENOENT: no such file or directory")
    expect(withScratchHint(wrapped, directory).message).toContain(os.tmpdir())
  })

  it("leaves a failure that is not about paths alone", () => {
    // ENOSPC is not a path the model can pick differently; sending it to the
    // temp dir would be worse than the error it replaced.
    const full = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" })
    expect(withScratchHint(full, directory)).toBe(full)
  })

  it("annotates the sweep's error verbatim, code and all absent", () => {
    // What the `bunny-p5` sweep actually recorded, as a bare string: the model
    // invented `C:\Users\ADMINI~1\...` and Bun's mkdir came back EPERM. There
    // is no `.code` to read here, so the message is the only place it can be.
    const sweepError = new Error(
      "EPERM: operation not permitted, mkdir 'C:\\Users\\ADMINI~1\\AppData\\Local\\Temp\\check_surcharge.py'",
    )
    const annotated = withScratchHint(sweepError, directory)
    expect(annotated.message).toContain("check_surcharge.py")
    expect(annotated.message).toContain(os.tmpdir())
    expect(annotated.message).toContain(directory)
  })

  it("covers the parent-directory failure Bun raises for an unwritable path", async () => {
    // `Bun.write` creates missing parents itself — this asserted the
    // opposite and passed for the wrong reason until the fixture was fixed.
    // So the failure `write` meets is never "the directory is absent": it is a
    // parent it may not create. Which is what the codes are for.
    const parent = path.join(os.tmpdir(), `nikcli-scratch-parent-${process.pid}`, "script.py")
    expect(
      await Bun.write(parent, "x").then(
        () => true,
        () => false,
      ),
    ).toBe(true)
  })
})

describe("notFoundMessage", () => {
  const directory = path.join(path.sep, "srv", "nikcli-project")

  it("points outside the project at the scratch paths", () => {
    expect(notFoundMessage("C:\\made\\up\\x.py", directory, true)).toContain(os.tmpdir())
  })

  it("stays plain inside the project, where the file name is what is wrong", () => {
    const inside = notFoundMessage(path.join(directory, "src", "x.py"), directory, false)
    expect(inside).toBe(`File not found: ${path.join(directory, "src", "x.py")}`)
    expect(inside).not.toContain(os.tmpdir())
  })
})

describe("scratchHint", () => {
  it("says both places and nothing else", () => {
    const hint = scratchHint("/home/dev/project")
    expect(hint).toBe(`Scratch files go in the temp dir ${os.tmpdir()} or the project dir /home/dev/project.`)
  })
})
