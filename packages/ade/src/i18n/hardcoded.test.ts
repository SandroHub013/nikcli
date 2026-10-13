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
  "setListenWarning",
  "stopListening",
  "noteError",
  "pickDirectory",
])

/** Names and symbols that read the same in any language. */
const NEUTRAL = /^(?:ADE|nik|ragu|ragù|RaguVerse|ssh|MCP|git|GitHub|OpenRouter|Codex|Claude Code|&lt;|&gt;|bun run|[A-Z][A-Z0-9_]+)$/

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

/** Files excluded from non-JSX object title property checks (matching pre-F7a2 baseline). */
function isExcludedTitle(path: string): boolean {
  const norm = path.replaceAll("\\", "/")
  return norm.endsWith("release-plan.ts") || norm.includes("nikverse/city/") || norm.includes("/voice/")
}

/**
 * Files and zones excluded per-file from the hardcoded prose ratchet (F7a2 review O1).
 * Never exclude whole folders (session/, bots/, design/, decisions/) so translated
 * files like worktree-close, metrics, and bots/ remain guarded at 0.
 */
const EXCLUDED_PROSE_FILES = new Set([
  // Excluded zones (per F7a/F7a2 specification):
  "update/release-plan.ts", // Changelog and release plan generator CLI script
  "session/permission.ts", // Voice regex dependencies (mapChoiceLabelToItalian)

  // Internal CLI / IPC protocol implementation (ade-msg terminal stdout/stderr, not UI):
  "session/mailbox.ts", // ade-msg terminal mailbox commands and status formatting
  "session/orchestra.ts", // Orchestra conductor CLI protocol
  "session/native-mail.ts", // Native mailbox IPC protocol
  "session/register-write.ts", // Session registration IPC protocol
  "session/shared.ts", // Shared session protocol messages
  "session/quota.ts", // Session quota management CLI protocol
  "session/quota-pick.ts", // Quota picker CLI protocol
  "session/senders.ts", // Sender identity resolution protocol

  // Panel IPC handlers (@ade command line terminal reply formatting, not UI components):
  "panels/router.ts", // @ade command routing
  "record/record-panel.ts", // @ade record command replies
  "secrets/keys.ts", // @ade keys CLI command replies
  "simulator/commands.ts", // @ade simulator terminal commands
  "video/commands.ts", // @ade video terminal commands
  "video/video.ts", // Internal video pipeline error formatters
  "model3d/commands.ts", // @ade model3d terminal commands
  "browser/request.ts", // @ade browser IPC request handling

  // Dev scripts, test tools and CI guards (never shown in user window):
  "host/drive-test-app.ts", // Dev test driver script
  "host/stt-stream.ts", // Speech-to-text audio streaming protocol
  "update/feed-guard.ts", // CI feed integrity checker script
  "brand.ts", // Branding CLI tool
  "plugin/registry.ts", // Internal plugin registry errors

  // Internal data/type mappings:
  "sidebar/workspace-tree.ts", // AgentDisplayStatus type union mapped via t() in sidebar.tsx

  // Decision, design and bot terminal queue dispatching:
  "decisions/delivery.ts", // @ade decisions delivery protocol
  "design/delivery.ts", // @ade design delivery protocol
  "design/notes.ts", // @ade design notes protocol
  "design/propose.ts", // ade-msg design proponi: refusals and the choice line, printed to the agent
  "bots/runners.ts", // Bot runner execution wrapper
  "bots/gateway/policy.ts", // Bot gateway access policy check
])

function isExcludedProse(path: string): boolean {
  const norm = path.replaceAll("\\", "/")
  if (norm.includes("nikverse/") || norm.includes("/voice/") || norm.startsWith("voice/")) return true
  for (const file of EXCLUDED_PROSE_FILES) {
    if (norm.endsWith(file)) return true
  }
  return false
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
      !isExcludedTitle(path)
    ) {
      const texts: string[] = []
      sinkTexts(node.initializer, texts)
      found += texts.filter((text) => isText(text.trim())).length
    } else if (
      ts.isPropertyAssignment(node) &&
      PROSE_PROPERTIES.has(node.name.getText()) &&
      !ts.isJsxAttribute(node.parent) &&
      !isExcludedProse(path)
    ) {
      const texts: string[] = []
      sinkTexts(node.initializer, texts)
      found += texts.filter((text) => isProse(text)).length
    } else if (
      (ts.isNewExpression(node) ||
        (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Error")) &&
      node.expression.getText() === "Error" &&
      node.arguments &&
      !isExcludedProse(path)
    ) {
      const texts: string[] = []
      for (const argument of node.arguments) sinkTexts(argument, texts)
      found += texts.filter((text) => isProse(text)).length
    } else if (
      ts.isReturnStatement(node) &&
      node.expression &&
      !isExcludedProse(path)
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
        'export const errNoNew = () => { throw Error("Indirizzo non valido nel modulo") }',
        'export function askUser() { return "Vuoi procedere con l operazione richiesta?" }',
        'export const okR = { reason: t("some.reason") }',
        'export const okP = { problem: t("some.problem") }',
        'export const okD = { detail: t("some.detail") }',
        'export const okN = { note: t("some.note") }',
        'export const okE = { error: t("some.error") }',
        'export const okErr = () => { throw new Error(t("some.error")) }',
        'export const okErrNoNew = () => { throw Error(t("some.error")) }',
        'export function okAsk() { return t("some.question") }',
        'export const machineCodes = { reason: "timeout", problem: "busy", error: "ENOENT" }',
      ].join("\n"),
    )
    try {
      expect(count(fixtureTs)).toBe(8)
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
