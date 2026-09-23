import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createRoot, createSignal } from "solid-js"
import { changedLinesAreSensitive, createFileCover, fileIsSensitive, whenToJudge, type CoverState } from "./sensitive-file"
import { RECORDING_ATTRIBUTE } from "../record/sensitive"

/** A selector list split on its own commas, not on those inside `:is(...)`. */
function splitSelectors(header: string): string[] {
  const parts: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < header.length; i++) {
    if (header[i] === "(") depth++
    else if (header[i] === ")") depth--
    else if (header[i] === "," && depth === 0) {
      parts.push(header.slice(from, i))
      from = i + 1
    }
  }
  parts.push(header.slice(from))
  return parts.map((part) => part.trim())
}

/** The rules of index.css under a marked pane during a take, one per selector, with their declarations. */
function sensitiveRules(): { selector: string; body: string }[] {
  const css = readFileSync(join(import.meta.dir, "..", "index.css"), "utf8")
  return css.split("}").flatMap((block) => {
    const open = block.indexOf("{")
    if (open === -1) return []
    const comment = block.lastIndexOf("*/", open)
    const header = block.slice(comment === -1 ? 0 : comment + 2, open)
    const body = block.slice(open + 1)
    return splitSelectors(header)
      .filter((selector) => selector.startsWith(`html[${RECORDING_ATTRIBUTE}] [data-sensitive]`))
      .map((selector) => ({ selector, body }))
  })
}

const at = (path: string, text: string | undefined, covering = true): CoverState => ({ path, text, covering })

// Fake values only: none of these is, or was ever, a real credential.
describe("fileIsSensitive", () => {
  test("a .env is covered for its name, even empty", () => {
    expect(fileIsSensitive(".env", "")).toBe(true)
    expect(fileIsSensitive("C:\\p\\.env.local", "PORT=3000")).toBe(true)
  })

  test("the names secrets are kept under", () => {
    for (const path of ["id_rsa", "~/.ssh/id_ed25519", "server.pem", "tls.key", ".npmrc", ".netrc", ".pypirc", ".git-credentials", "aws-credentials.json", "client_secret.json"]) {
      expect(fileIsSensitive(path, undefined)).toBe(true)
    }
    expect(fileIsSensitive("id_rsa.pub", "ssh-ed25519 AAAA")).toBe(false)
  })

  test("a config.ts with DB_PASS= is covered for what it says", () => {
    expect(fileIsSensitive("src/config.ts", 'export const port = 3000\nconst DB_PASS="hunter2hunter2"\n')).toBe(true)
  })

  test("a README is not", () => {
    expect(fileIsSensitive("README.md", "# ADE\n\nRun `npm run build`, then `git status`.\n")).toBe(false)
  })
})

describe("the pane's cover", () => {
  test("net 1 of index.css covers a pane marked data-sensitive, and what it draws", () => {
    const selectors = sensitiveRules()
      .map((rule) => rule.selector)
      .filter((selector) => !selector.includes("::"))
    expect(selectors).toContain(`html[${RECORDING_ATTRIBUTE}] [data-sensitive]`)

    const view = '<textarea></textarea><div data-slot="file-markdown"><p>x</p></div>'
    document.body.innerHTML =
      `<article data-component="file-pane"><div id="marked" data-slot="pane-editor" data-sensitive="">${view}</div></article>` +
      `<article data-component="file-pane"><div id="clean" data-slot="pane-editor">${view}</div></article>`
    const covered = (element: Element) => selectors.some((selector) => element.matches(selector))
    document.documentElement.setAttribute(RECORDING_ATTRIBUTE, "")

    const marked = document.getElementById("marked")!
    expect(covered(marked)).toBe(true)
    for (const element of Array.from(marked.querySelectorAll("*"))) expect(covered(element)).toBe(true)

    const clean = document.getElementById("clean")!
    expect(covered(clean)).toBe(false)
    for (const element of Array.from(clean.querySelectorAll("*"))) expect(covered(element)).toBe(false)

    document.documentElement.removeAttribute(RECORDING_ATTRIBUTE)
    document.body.innerHTML = ""
  })
})

describe("when the pane is judged (audit 0.7.7, R2)", () => {
  test("at once when the text arrives, the path changes or the take begins", () => {
    expect(whenToJudge(at("config.ts", undefined), at("config.ts", 'DB_PASS="hunter2hunter2"'))).toBe("now")
    expect(whenToJudge(at("a.ts", "x = 1"), at("b.ts", "x = 1"))).toBe("now")
    expect(whenToJudge(at("config.ts", "x = 1", false), at("config.ts", "x = 1"))).toBe("now")
    expect(whenToJudge(undefined, at("config.ts", "x = 1"))).toBe("now")
  })

  test("throttled only while a text already shown is typed into, and never outside a take", () => {
    expect(whenToJudge(at("config.ts", "x = 1"), at("config.ts", "x = 12"))).toBe("throttle")
    expect(whenToJudge(at("config.ts", "x = 1"), at("config.ts", "x = 1", false))).toBe("off")
  })

  test("a pane whose text arrives with DB_PASS= is covered in the same tick, with no timer", () => {
    const [state, setState] = createSignal(at("src/config.ts", undefined))
    let sensitive!: () => boolean
    const dispose = createRoot((dispose) => {
      sensitive = createFileCover(state)
      return dispose
    })
    // Clean by its name while it loads.
    expect(sensitive()).toBe(false)
    setState(at("src/config.ts", 'export const port = 3000\nconst DB_PASS="hunter2hunter2"\n'))
    expect(sensitive()).toBe(true)
    dispose()
  })

  test("a secret pasted into a clean file is covered at once, inside the throttle", () => {
    const [state, setState] = createSignal(at("src/app.ts", "export const port = 3000\n"))
    let sensitive!: () => boolean
    const dispose = createRoot((dispose) => {
      sensitive = createFileCover(state)
      return dispose
    })
    expect(sensitive()).toBe(false)
    // Judged whole a moment ago: the whole-file read now waits for the throttle.
    setState(at("src/app.ts", "export const port = 3000\nconst x = 1\n"))
    expect(sensitive()).toBe(false)
    setState(at("src/app.ts", 'export const port = 3000\nconst DB_PASS="hunter2hunter2"\nconst x = 1\n'))
    expect(sensitive()).toBe(true)
    dispose()
  })

  test("only the changed lines are read while typing", () => {
    const clean = "export const port = 3000\n"
    expect(changedLinesAreSensitive(clean, clean + 'const DB_PASS="hunter2hunter2"\n')).toBe(true)
    expect(changedLinesAreSensitive(clean, 'const DB_PASS="hunter2hunter2"\n' + clean)).toBe(true)
    // A secret typed one character at a time is caught on its own line.
    expect(changedLinesAreSensitive('const DB_PASS="hunter2hunter', 'const DB_PASS="hunter2hunter2"')).toBe(true)
    expect(changedLinesAreSensitive(clean, clean + "const x = 1\n")).toBe(false)
    // A line left as it was is not read again: the whole-file read covers it.
    expect(changedLinesAreSensitive('DB_PASS="hunter2hunter2"\nx = 1', 'DB_PASS="hunter2hunter2"\nx = 12')).toBe(false)
  })
})

describe("the viewers under a covered pane", () => {
  test("an image, a video, a canvas or an SVG is blurred: a colour does not hide its pixels", () => {
    const rule = sensitiveRules().find((rule) => rule.selector === `html[${RECORDING_ATTRIBUTE}] [data-sensitive] :is(img, video, canvas, svg)`)
    expect(rule).toBeDefined()
    expect(rule!.body).toMatch(/filter:\s*blur\(0\.8em\)/)
  })
})

describe("image and video viewers during a take (audit 0.7.7, R2)", () => {
  const css = () => readFileSync(join(import.meta.dir, "..", "index.css"), "utf8")
  const blurRule = () => {
    const text = css()
    const rule = text.slice(text.indexOf(`html[${RECORDING_ATTRIBUTE}] [data-slot="file-view"]`))
    return { selectors: splitSelectors(rule.slice(0, rule.indexOf("{"))), body: rule.slice(rule.indexOf("{"), rule.indexOf("}")) }
  }

  test("are blurred whole, whatever the file is called; the markdown preview and the editor are not", () => {
    const { selectors, body } = blurRule()
    expect(body).toMatch(/filter:\s*blur\(0\.8em\)/)
    // Drawn again after each change to <html>: happy-dom keeps an element's match across an ancestor's attribute change.
    const draw = () => {
      document.body.innerHTML = [
        '<div data-slot="file-view" data-kind="image" id="image"><img data-slot="file-image"></div>',
        '<div data-slot="file-view" data-kind="svg" id="svg"><img data-slot="file-image"></div>',
        '<video data-slot="video-element" id="video"></video>',
        '<div data-slot="file-markdown" id="markdown"></div>',
        '<div data-slot="file-view" data-kind="font" id="font"></div>',
        '<textarea id="editor"></textarea>',
      ].join("")
    }
    const blurred = (id: string) => selectors.some((selector) => document.getElementById(id)!.matches(selector))
    document.documentElement.setAttribute(RECORDING_ATTRIBUTE, "")
    draw()
    for (const id of ["image", "svg", "video"]) expect([id, blurred(id)]).toEqual([id, true])
    for (const id of ["markdown", "font", "editor"]) expect([id, blurred(id)]).toEqual([id, false])
    // Outside a take nothing is blurred.
    document.documentElement.removeAttribute(RECORDING_ATTRIBUTE)
    draw()
    expect(["image", "svg", "video"].some(blurred)).toBe(false)
    document.body.innerHTML = ""
  })

  test("the names the rule uses are the ones the viewers draw", () => {
    const view = readFileSync(join(import.meta.dir, "file-view.tsx"), "utf8")
    const video = readFileSync(join(import.meta.dir, "..", "video", "video-pane.tsx"), "utf8")
    expect(view).toContain('data-slot="file-view" data-kind="image"')
    expect(view).toContain('data-slot="file-view" data-kind="svg"')
    expect(video).toContain('data-slot="video-element"')
  })

  test("SVG viewer handles load errors with the same message as images (Punto 10)", () => {
    const view = readFileSync(join(import.meta.dir, "file-view.tsx"), "utf8")
    // SVG viewer must have onError handler and render file.imageFailed fallback on error
    const svgViewIndex = view.indexOf("function SvgView")
    expect(svgViewIndex).toBeGreaterThan(-1)
    const svgViewSlice = view.slice(svgViewIndex)
    const svgBody = svgViewSlice.slice(0, svgViewSlice.indexOf("\n}"))
    expect(svgBody).toContain("onError={() => setFailed(true)}")
    expect(svgBody).toContain('data-slot="file-message"')
    expect(svgBody).toContain('t("file.imageFailed")')
    expect(svgBody).toContain('data-slot="file-view" data-kind="svg"')
    expect(svgBody).toContain('data-slot="file-image"')
  })
})
