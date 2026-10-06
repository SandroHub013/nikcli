import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"
import { ACTIVITY_CODES } from "../grid/activity"

/*
 * A ratchet on the text written straight into JSX (S41).
 *
 * Counts, per file, the JSX text and the user-facing attributes that are
 * fixed strings rather than `t(…)`, and the fixed text handed to the calls
 * that put words on screen outside JSX: notices, panel notes, reports and
 * inline problems. A pane activity written as a sentence instead of one of
 * the codes in `grid/activity.ts` counts too. The count may only go down: a file
 * above its baseline has gained an untranslated text, and a file below it has
 * lost some and should say so, so the next regression is caught at the new
 * level. `ADE_I18N_BASELINE=write bun run test:unit` rewrites the baseline.
 *
 * The voice package is counted too, under `voice/`: its panel reads the same
 * catalog with the same `t()`, and it is where the Kokoro pack's texts are (K6).
 */

const SRC = join(import.meta.dir, "..")
const VOICE = join(import.meta.dir, "..", "..", "..", "voice", "src")
const BASELINE = join(import.meta.dir, "hardcoded-baseline.json")

const UI_ATTRIBUTES = new Set([
  "title",
  "aria-label",
  "placeholder",
  "alt",
  "label",
  "emptyLabel",
  "subtitle",
  "description",
])

/** Calls whose text arguments end up on screen. */
const SINKS = new Set([
  "appendLine",
  "tellPane",
  "noteInTerminal",
  "report",
  "addNotice",
  "setNotice",
  "setNote",
  "setProblem",
  "setError",
  "setLoadError",
  "setVoiceNotice",
  "setVoiceSettingsNotice",
  "pickDirectory",
])

/** Names and symbols that read the same in any language. */
const NEUTRAL = /^(?:ADE|nik|nikcli|NikVerse|ssh|MCP|git|GitHub|OpenRouter|Codex|Claude Code|&lt;|&gt;|bun run|[A-Z][A-Z0-9_]+)$/

function sources(dir: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name !== "node_modules") sources(path, into)
    } else if (/\.tsx?$/.test(name) && !name.includes(".test.") && !name.endsWith(".d.ts")) into.push(path)
  }
  return into
}

const isText = (text: string) => /\p{L}{2,}/u.test(text) && !NEUTRAL.test(text)
/** Outside JSX a string is often a kind or an id; words with a space are prose. */
const isProse = (text: string) => isText(text.trim()) && /\p{L}{2,}\s+\p{L}/u.test(text)

/** The fixed words in a literal or template, or undefined when it is not one. */
function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node))
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ")
  return undefined
}

const calleeName = (call: ts.CallExpression) => {
  const callee = call.expression
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text
  return undefined
}

/** Fixed text reaching a sink, directly, through `a ? "x" : "y"`, or as an object's `text`. */
function sinkTexts(node: ts.Expression, into: string[]): void {
  const text = literalText(node)
  if (text !== undefined) into.push(text)
  else if (ts.isConditionalExpression(node)) {
    sinkTexts(node.whenTrue, into)
    sinkTexts(node.whenFalse, into)
  } else if (ts.isParenthesizedExpression(node)) sinkTexts(node.expression, into)
  else if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property) && property.name.getText() === "text") sinkTexts(property.initializer, into)
    }
  }
}

const PROSE_PROPERTIES = new Set(["reason", "problem", "detail", "note", "error"])

/**
 * Files and zones excluded from the hardcoded prose ratchet:
 * - Excluded zones (per F7a2 specification):
 *     release-plan.ts: changelog and release plan generator script
 *     session/permission.ts: voice regex dependencies (mapChoiceLabelToItalian)
 *     voice/: Kokoro and voice pack subsystem
 *     nikverse/: 3D world city frame and handshake/iframe protocols
 * - Internal CLI / IPC protocol implementation (ade-msg terminal stdout/stderr, not UI):
 *     session/ and session-new/ (internal subagent mailbox, orchestra, native mail, etc.)
 * - Panel IPC handlers (@ade command line terminal reply formatting, not UI components):
 *     panels/router.ts, record/record-panel.ts, secrets/keys.ts, simulator/commands.ts,
 *     video/commands.ts, video/video.ts
 * - Internal dev scripts, test tools and CI guards (never shown in user window):
 *     host/drive-test-app.ts, update/feed-guard.ts, brand.ts
 * - Internal data/type mappings:
 *     plugin/discovery.ts (internal RefusedPlugin reason codes)
 *     sidebar/workspace-tree.ts (AgentDisplayStatus type union mapped via t() in sidebar.tsx)
 *     decisions/, design/, bots/ (terminal queue dispatching and LLM prompt wrappers)
 */
function isExcluded(path: string): boolean {
  const norm = path.replace(/\\/g, "/")
  return (
    norm.endsWith("release-plan.ts") ||
    norm.endsWith("session/permission.ts") ||
    norm.includes("nikverse/") ||
    norm.includes("/voice/") ||
    norm.startsWith("voice/") ||
    norm.includes("/session/") ||
    norm.includes("/session-new/") ||
    norm.endsWith("panels/router.ts") ||
    norm.endsWith("record/record-panel.ts") ||
    norm.endsWith("secrets/keys.ts") ||
    norm.endsWith("simulator/commands.ts") ||
    norm.endsWith("video/commands.ts") ||
    norm.endsWith("video/video.ts") ||
    norm.endsWith("model3d/commands.ts") ||
    norm.endsWith("browser/request.ts") ||
    norm.endsWith("host/stt-stream.ts") ||
    norm.endsWith("plugin/registry.ts") ||
    norm.endsWith("host/drive-test-app.ts") ||
    norm.endsWith("update/feed-guard.ts") ||
    norm.endsWith("brand.ts") ||
    norm.endsWith("plugin/discovery.ts") ||
    norm.endsWith("sidebar/workspace-tree.ts") ||
    norm.includes("/decisions/") ||
    norm.includes("/design/") ||
    norm.includes("/bots/")
  )
}

function count(path: string): number {
  const file = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  let found = 0
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      if (isText(node.getText().replace(/\s+/g, " ").trim())) found++
    } else if (ts.isJsxAttribute(node) && node.initializer && UI_ATTRIBUTES.has(node.name.getText())) {
      // A literal, a template's fixed words, either side of a ternary: only
      // the literal was seen, so `title={`Stato: ${x}`}` had a baseline of 0
      // (review area 2, MEDIO).
      const init = node.initializer
      const texts: string[] = []
      if (ts.isStringLiteral(init)) texts.push(init.text)
      else if (ts.isJsxExpression(init) && init.expression) sinkTexts(init.expression, texts)
      found += texts.filter((text) => isText(text.trim())).length
    } else if (ts.isCallExpression(node) && SINKS.has(calleeName(node) ?? "")) {
      const texts: string[] = []
      for (const argument of node.arguments) sinkTexts(argument, texts)
      const isPick = calleeName(node) === "pickDirectory"
      found += texts.filter((text) => (isPick ? isText(text.trim()) : isProse(text))).length
    } else if (
      ts.isPropertyAssignment(node) &&
      node.name.getText() === "activity" &&
      ts.isStringLiteral(node.initializer) &&
      !(ACTIVITY_CODES as readonly string[]).includes(node.initializer.text)
    ) {
      found++
    } else if (
      ts.isPropertyAssignment(node) &&
      node.name.getText() === "title" &&
      !ts.isJsxAttribute(node.parent) &&
      !isExcluded(path)
    ) {
      const texts: string[] = []
      sinkTexts(node.initializer, texts)
      found += texts.filter((text) => isText(text.trim())).length
    } else if (
      ts.isPropertyAssignment(node) &&
      PROSE_PROPERTIES.has(node.name.getText()) &&
      !ts.isJsxAttribute(node.parent) &&
      !isExcluded(path)
    ) {
      const texts: string[] = []
      sinkTexts(node.initializer, texts)
      found += texts.filter((text) => isProse(text)).length
    } else if (
      ts.isNewExpression(node) &&
      node.expression.getText() === "Error" &&
      node.arguments &&
      !isExcluded(path)
    ) {
      const texts: string[] = []
      for (const argument of node.arguments) sinkTexts(argument, texts)
      found += texts.filter((text) => isProse(text)).length
    } else if (
      ts.isReturnStatement(node) &&
      node.expression &&
      !isExcluded(path)
    ) {
      const texts: string[] = []
      sinkTexts(node.expression, texts)
      found += texts.filter((text) => isProse(text)).length
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

function measure(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const [root, prefix] of [
    [SRC, ""],
    [VOICE, "voice/"],
  ] as const) {
    for (const path of sources(root).sort()) {
      const n = count(path)
      if (n > 0) counts[prefix + relative(root, path).replace(/\\/g, "/")] = n
    }
  }
  return counts
}

describe("fixed text in JSX", () => {
  /*
   * Measured here, while the file loads, not in the test. It reads and parses
   * some 330 sources, and had a timeout of 30 s that was still not enough
   * right after a checkout: on Windows the first open of a file just written
   * waits for the antivirus. Loading is not timed per test.
   */
  const now = measure()

  test("an attribute's template and ternary count, not only its literal", () => {
    const dir = join(require("node:os").tmpdir(), `ade-hardcoded-${process.pid}`)
    require("node:fs").mkdirSync(dir, { recursive: true })
    const fixture = join(dir, "fixture.tsx")
    writeFileSync(
      fixture,
      [
        "export const A = (x: string) => <span title={`Stato: ${x}`} />",
        'export const B = (x: boolean) => <b aria-label={x ? "Apri" : "Chiudi"} />',
        "export const C = (x: string) => <i title={`${x} · ${x}`} aria-label={t(x)} />",
      ].join("\n"),
    )
    try {
      expect(count(fixture)).toBe(3)
    } finally {
      require("node:fs").rmSync(dir, { recursive: true, force: true })
    }
  })

  test("catches hardcoded text in pickDirectory, title properties, and non-JSX modules", () => {
    const dir = join(require("node:os").tmpdir(), `ade-hardcoded-non-jsx-${process.pid}`)
    require("node:fs").mkdirSync(dir, { recursive: true })
    const fixtureTs = join(dir, "fixture.ts")
    writeFileSync(
      fixtureTs,
      [
        'export const open = (host: any) => host.pickDirectory("Apri cartella")',
        'export const cmd = { title: "Mostra plugin" }',
        'export const ok = { title: t("cmd.title") }',
        'export const okPick = (host: any) => host.pickDirectory(t("pick.dir"))',
      ].join("\n"),
    )
    try {
      expect(count(fixtureTs)).toBe(2)
    } finally {
      require("node:fs").rmSync(dir, { recursive: true, force: true })
    }
  })

  test("catches hardcoded prose in reason, problem, detail, note, error, new Error, and return statements", () => {
    const dir = join(require("node:os").tmpdir(), `ade-hardcoded-props-${process.pid}`)
    require("node:fs").mkdirSync(dir, { recursive: true })
    const fixtureTs = join(dir, "fixture.ts")
    writeFileSync(
      fixtureTs,
      [
        'export const r = { reason: "Nessun dato trovato nel sistema" }',
        'export const p = { problem: "Impossibile caricare il file selezionato" }',
        'export const d = { detail: "La connessione è caduta improvvisamente" }',
        'export const n = { note: "Attenzione alle modifiche non salvate" }',
        'export const e = { error: "Errore durante il salvataggio dei file" }',
        'export const err = () => { throw new Error("Questo indirizzo non è valido") }',
        'export function askUser() { return "Vuoi procedere con l operazione richiesta?" }',
        'export const okR = { reason: t("some.reason") }',
        'export const okP = { problem: t("some.problem") }',
        'export const okD = { detail: t("some.detail") }',
        'export const okN = { note: t("some.note") }',
        'export const okE = { error: t("some.error") }',
        'export const okErr = () => { throw new Error(t("some.error")) }',
        'export function okAsk() { return t("some.question") }',
        'export const machineCodes = { reason: "timeout", problem: "busy", error: "ENOENT" }',
      ].join("\n"),
    )
    try {
      expect(count(fixtureTs)).toBe(7)
    } finally {
      require("node:fs").rmSync(dir, { recursive: true, force: true })
    }
  })

  test("does not grow, and the baseline follows it down", () => {
    if (process.env.ADE_I18N_BASELINE === "write") {
      writeFileSync(BASELINE, JSON.stringify(now, null, 2) + "\n")
      return
    }
    const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as Record<string, number>
    const grew: string[] = []
    const shrank: string[] = []
    for (const file of new Set([...Object.keys(now), ...Object.keys(baseline)])) {
      const was = baseline[file] ?? 0
      const is = now[file] ?? 0
      if (is > was) grew.push(`${file}: ${was} → ${is} (use t() from src/i18n)`)
      if (is < was) shrank.push(`${file}: ${was} → ${is} (lower the baseline: ADE_I18N_BASELINE=write)`)
    }
    expect(grew).toEqual([])
    expect(shrank).toEqual([])
  })
})
