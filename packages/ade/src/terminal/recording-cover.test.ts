import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { CLEAN_ATTRIBUTE, judgeRows, logicalLine, rowIsClean, selectionReachesSecret, watchRows, type CoverBuffer } from "./recording-cover"
import { RECORDING_ATTRIBUTE } from "../record/sensitive"
import { coverTerminals, createTerminalKeyHandler, disposeTerminal, getTerminal } from "./registry"

// Fake keys only: none of these is, or was ever, a real credential.
const FAKE_KEY = "sk-ant-api03-FALSAFALSAFALSAFALSA"
/** A key with no known prefix: only its length gives it away, and each half is too short to. */
const FAKE_OPAQUE = "Zm9vYmFyMTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1u"

describe("rowIsClean (D68)", () => {
  const clean = [
    "npm test",
    String.raw`C:\Users\39349\Favorites\nikcli-ade-d68>`,
    "a1b2c3d fix(ade): copy on release",
    "e7d49246f fix(ade): the main window navigates to ADE's own page only",
    String.raw`C:\Users\39349\Favorites\nikcli-ade-d68\packages\ade\src\terminal\recording-cover.ts`,
    "normale",
    "",
  ]
  const secret = [
    FAKE_KEY,
    `echo ${FAKE_KEY}`,
    "export OPENAI_API_KEY=abc",
    "PROVA_TOKEN=abc",
    "Authorization: Bearer x",
    "password: hunter2",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlMTIzNDU2Nzg5MA",
    "ghp_FALSOfalsoFALSOfalso1234",
  ]

  for (const text of clean) test(`clean: ${text || "(empty)"}`, () => expect(rowIsClean(text)).toBe(true))
  for (const text of secret) test(`covered: ${text.slice(0, 40)}`, () => expect(rowIsClean(text)).toBe(false))
})

/** A buffer of rows; `wrapped` marks a row the width continued from the one above. */
function fakeBuffer(rows: Array<{ text: string; wrapped?: boolean }>, viewportY = 0): CoverBuffer & { rows: typeof rows } {
  return {
    rows,
    viewportY,
    getLine: (y) => {
      const row = rows[y]
      if (!row) return undefined
      return { isWrapped: Boolean(row.wrapped), translateToString: (trim?: boolean) => (trim ? row.text.trimEnd() : row.text) }
    },
  }
}

/** A `.xterm-rows` with one div per row, drawn from `texts`. */
function fakeRows(texts: string[]): HTMLElement {
  const container = document.createElement("div")
  container.className = "xterm-rows"
  for (const text of texts) {
    const row = document.createElement("div")
    const span = document.createElement("span")
    span.textContent = text
    row.appendChild(span)
    container.appendChild(row)
  }
  document.body.appendChild(container)
  return container
}

const marks = (container: HTMLElement) => Array.from(container.children).map((row) => row.hasAttribute(CLEAN_ATTRIBUTE))
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("the row reader (D68)", () => {
  test("a clean row gets data-ade-clean, a secret one does not", () => {
    const texts = ["echo normale", `echo ${FAKE_KEY}`]
    const container = fakeRows(texts)
    const stop = watchRows(container, () => fakeBuffer(texts.map((text) => ({ text }))))
    expect(marks(container)).toEqual([true, false])
    stop()
    expect(marks(container)).toEqual([false, false])
    container.remove()
  })

  test("a row changed into a secret loses the mark in the same callback", async () => {
    const buffer = fakeBuffer([{ text: "npm test" }])
    const container = fakeRows(["npm test"])
    const stop = watchRows(container, () => buffer)
    expect(marks(container)).toEqual([true])
    buffer.rows[0].text = `echo ${FAKE_KEY}`
    container.children[0].firstChild!.textContent = `echo ${FAKE_KEY}`
    await tick()
    expect(marks(container)).toEqual([false])
    stop()
    container.remove()
  })

  test("with a judge that throws, no row stays clean", async () => {
    const buffer = fakeBuffer([{ text: "npm test" }, { text: "ls" }])
    const container = fakeRows(["npm test", "ls"])
    let broken = false
    const stop = watchRows(container, () => buffer, (text) => {
      if (broken) throw new Error("rotto")
      return rowIsClean(text)
    })
    expect(marks(container)).toEqual([true, true])
    broken = true
    container.children[0].firstChild!.textContent = "npm test"
    container.children[1].firstChild!.textContent = "ls"
    await tick()
    expect(marks(container)).toEqual([false, false])
    stop()
    container.remove()
  })

  test("a row drawn differently from the buffer stays blurred", () => {
    const container = fakeRows(["npm test", "ls -la"])
    judgeRows(container, fakeBuffer([{ text: "npm test" }, { text: "ls" }]), Array.from(container.children))
    expect(marks(container)).toEqual([true, false])
    container.remove()
  })

  test("a key the width cut in two leaves both rows blurred", () => {
    const half = Math.floor(FAKE_OPAQUE.length / 2)
    const rows = [{ text: `echo ${FAKE_OPAQUE.slice(0, half)}` }, { text: FAKE_OPAQUE.slice(half), wrapped: true }]
    // Each half alone would pass: the join is what gives it away.
    expect(rows.map((row) => rowIsClean(row.text))).toEqual([true, true])
    const container = fakeRows(rows.map((row) => row.text))
    judgeRows(container, fakeBuffer(rows), Array.from(container.children))
    expect(marks(container)).toEqual([false, false])
    container.remove()
  })

  test("rows are read at the viewport, not at the top of the scrollback", () => {
    const buffer = fakeBuffer([{ text: `echo ${FAKE_KEY}` }, { text: "npm test" }], 1)
    const container = fakeRows(["npm test"])
    judgeRows(container, buffer, Array.from(container.children))
    expect(marks(container)).toEqual([true])
    container.remove()
  })

  test("the logical line joins the rows the width wrapped", () => {
    const buffer = fakeBuffer([{ text: "a" }, { text: "bc " }, { text: "d", wrapped: true }, { text: "e" }])
    expect(logicalLine(buffer, 2)).toEqual({ first: 1, last: 2, text: "bc d" })
  })
})

describe("copying during a take (D68)", () => {
  test("a selection that reaches a blurred line is not copied, one that does not is", () => {
    const buffer = fakeBuffer([{ text: "npm test" }, { text: `echo ${FAKE_KEY}` }, { text: "ls" }])
    expect(selectionReachesSecret(buffer, 0, 0)).toBe(false)
    expect(selectionReachesSecret(buffer, 2, 2)).toBe(false)
    expect(selectionReachesSecret(buffer, 0, 2)).toBe(true)
  })

  test("half of a wrapped key is judged with its other half", () => {
    const half = Math.floor(FAKE_OPAQUE.length / 2)
    const buffer = fakeBuffer([{ text: FAKE_OPAQUE.slice(0, half) }, { text: FAKE_OPAQUE.slice(half), wrapped: true }])
    expect(selectionReachesSecret(buffer, 1, 1)).toBe(true)
  })
})

describe("the CSS (D68)", () => {
  test("blurs every terminal row not judged clean, and the IME's composition, under the recording attribute", () => {
    const css = readFileSync(join(import.meta.dir, "..", "index.css"), "utf8")
    const rule = css.slice(css.indexOf(`html[${RECORDING_ATTRIBUTE}] .xterm .xterm-rows`))
    const header = rule.slice(0, rule.indexOf("{"))
    expect(header).toContain(`html[${RECORDING_ATTRIBUTE}] .xterm .xterm-rows > div:not([${CLEAN_ATTRIBUTE}])`)
    expect(header).toContain(`html[${RECORDING_ATTRIBUTE}] .xterm .composition-view`)
    expect(rule.slice(rule.indexOf("{"), rule.indexOf("}"))).toMatch(/filter:\s*blur\(0\.8em\)/)
  })
})

describe("where no reader reaches, during a take (D68, Architect)", () => {
  test("the transcript and the screenshots in the tray are blurred whole", () => {
    const css = readFileSync(join(import.meta.dir, "..", "index.css"), "utf8")
    const rule = css.slice(css.indexOf(`html[${RECORDING_ATTRIBUTE}] [data-slot="pane-transcript"]`))
    const header = rule.slice(0, rule.indexOf("{"))
    expect(header).toContain(`html[${RECORDING_ATTRIBUTE}] [data-slot="pane-transcript"]`)
    // Not scoped to the tray: the full-size viewer is its sibling, and draws the same image.
    expect(header).toContain(`html[${RECORDING_ATTRIBUTE}] [data-slot="shot-image"]`)
    expect(rule.slice(rule.indexOf("{"), rule.indexOf("}"))).toMatch(/filter:\s*blur\(0\.8em\)/)
  })

  test("the names the rule uses are the ones the components draw", () => {
    const pane = readFileSync(join(import.meta.dir, "..", "grid", "pane.tsx"), "utf8")
    const tray = readFileSync(join(import.meta.dir, "..", "shots", "tray.tsx"), "utf8")
    expect(pane).toContain('data-slot="pane-transcript"')
    expect(tray).toContain('data-component="shot-tray"')
    expect(tray).toContain('data-slot="shot-image"')
  })

  test("the full-size viewer draws its screenshot with the same shot-image, so the rule reaches it", () => {
    const tray = readFileSync(join(import.meta.dir, "..", "shots", "tray.tsx"), "utf8")
    const viewer = tray.slice(tray.indexOf('data-component="shot-viewer"'))
    expect(tray).toContain('data-component="shot-viewer"')
    // The viewer renders the same <Thumb>, whose <img> is the shot-image.
    expect(viewer).toMatch(/<Thumb/)
    expect(tray.slice(tray.indexOf("function Thumb"), tray.indexOf("function Thumb") + 1200)).toContain('data-slot="shot-image"')
  })
})

describe("a copy refused during a take says so (D68, Architect)", () => {
  test("Ctrl+C on a selection that reaches a secret copies nothing and calls the note", () => {
    const id = "d68-copy-blocked"
    const terminal = getTerminal(id).terminal
    const buffer = fakeBuffer([{ text: `echo ${FAKE_KEY}` }])
    Object.defineProperty(terminal, "buffer", { value: { active: buffer }, configurable: true })
    terminal.hasSelection = () => true
    terminal.getSelectionPosition = () => ({ start: { x: 0, y: 0 }, end: { x: 10, y: 0 } })
    let cleared = false
    terminal.clearSelection = () => {
      cleared = true
    }
    const original = navigator.clipboard
    let written = 0
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => void written++ }, configurable: true })
    let blocked = 0
    coverTerminals(true)
    try {
      const handled = createTerminalKeyHandler(terminal, () => blocked++)(new KeyboardEvent("keydown", { key: "c", ctrlKey: true }))
      expect(handled).toBe(false)
      expect([blocked, written, cleared]).toEqual([1, 0, true])
    } finally {
      coverTerminals(false)
      Object.defineProperty(navigator, "clipboard", { value: original, configurable: true })
      disposeTerminal(id)
    }
  })
})
