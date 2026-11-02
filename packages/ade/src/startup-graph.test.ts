import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import ts from "typescript"

/*
 * What the first load pulls in, read from the imports.
 *
 * ADE's entry is `dev.tsx`; everything it reaches through a static `import` is
 * in the main bundle and is parsed before the first frame. This walks that
 * graph the way the bundler does (no `import()`, no `import type`) and pins what
 * must stay out of it: the voice package's engine, and every pane or sheet that
 * is only worth loading when it is opened. Each of those was in the main chunk
 * until 2026-11-02 (2.7 MB, now 2.1 MB); a static import that brings one back
 * is a red test here rather than a slower start nobody measured.
 */

const ADE_SRC = resolve(import.meta.dir)
const VOICE_SRC = resolve(import.meta.dir, "..", "..", "voice", "src")
const ENTRY = join(ADE_SRC, "dev.tsx")

/** Where a package specifier lands, for the packages whose code is in the graph. */
function resolveSpecifier(from: string, specifier: string): string | undefined {
  let base: string
  if (specifier.startsWith(".")) base = resolve(dirname(from), specifier)
  else if (specifier === "@ragu/voice") base = join(VOICE_SRC, "index")
  else if (specifier === "@ragu/voice/core") base = join(VOICE_SRC, "core")
  else if (specifier === "@ragu/voice/light") base = join(VOICE_SRC, "light")
  else if (specifier.startsWith("@ragu/ade/")) base = join(ADE_SRC, specifier.slice("@ragu/ade/".length))
  else if (specifier.startsWith("@/")) base = join(ADE_SRC, specifier.slice(2))
  else return undefined
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && /\.tsx?$/.test(candidate)) return candidate
  }
  return undefined
}

interface ValueImport {
  specifier: string
}

/** The imports a bundler would follow: not `import type`, not a clause whose names are all `type`. */
function staticImports(file: string, text: string): ValueImport[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const found: ValueImport[] = []
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause
      if (clause?.isTypeOnly) continue
      const named = clause?.namedBindings
      const onlyTypes =
        clause !== undefined &&
        !clause.name &&
        named !== undefined &&
        ts.isNamedImports(named) &&
        named.elements.length > 0 &&
        named.elements.every((element) => element.isTypeOnly)
      if (onlyTypes) continue
      found.push({ specifier: statement.moduleSpecifier.text })
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      if (statement.isTypeOnly) continue
      const named = statement.exportClause
      if (
        named &&
        ts.isNamedExports(named) &&
        named.elements.length > 0 &&
        named.elements.every((element) => element.isTypeOnly)
      )
        continue
      found.push({ specifier: statement.moduleSpecifier.text })
    }
  }
  return found
}

/**
 * Every file the entry reaches statically, who imported each package specifier that names the voice's barrels, the
 * stylesheets that come with them (by the file that imports each), and who imports `effect`.
 */
function walk(entry: string) {
  const seen = new Set<string>()
  const barrelImporters: string[] = []
  const styles = new Map<string, string[]>()
  const effectImporters: string[] = []
  const stack = [entry]
  while (stack.length > 0) {
    const file = stack.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const { specifier } of staticImports(file, readFileSync(file, "utf8"))) {
      if (specifier === "@ragu/voice" || specifier === "@ragu/voice/core") barrelImporters.push(relative(ADE_SRC, file))
      if (specifier === "effect" || specifier.startsWith("effect/")) effectImporters.push(file)
      if (specifier.endsWith(".css")) {
        const sheet = resolve(dirname(file), specifier)
        styles.set(sheet, [...(styles.get(sheet) ?? []), file])
        continue
      }
      const next = resolveSpecifier(file, specifier)
      if (next) stack.push(next)
    }
  }
  return { seen, barrelImporters, styles, effectImporters }
}

const graph = walk(ENTRY)
const inGraph = (path: string) => graph.seen.has(join(ADE_SRC, path)) || graph.seen.has(join(VOICE_SRC, path))

describe("the main entry", () => {
  test("is read: the walk reaches the workbench and the light voice entry", () => {
    expect(graph.seen.size).toBeGreaterThan(300)
    expect(inGraph("surface/workbench.tsx")).toBe(true)
    expect(inGraph("light.ts")).toBe(true)
  })

  test("no longer imports the voice package statically", () => {
    // Neither the barrel nor its mirror: the engine comes in with `import()` (`buildVoiceRuntime`).
    expect(graph.barrelImporters).toEqual([])
    expect(inGraph("index.ts")).toBe(false)
    expect(inGraph("core.ts")).toBe(false)
    expect(inGraph("engine.ts")).toBe(false)
    expect(inGraph("effect/layers.ts")).toBe(false)
    expect(inGraph("effect/program.ts")).toBe(false)
    expect(inGraph("audio/capture.ts")).toBe(false)
    expect(inGraph("tts/natural-speaker.ts")).toBe(false)
    expect(inGraph("tts/mai-speaker.ts")).toBe(false)
    expect(inGraph("settings/spend.ts")).toBe(false)
  })

  test("keeps the voice's settings pages out until the settings panel opens", () => {
    expect(inGraph("settings/settings-sheet.tsx")).toBe(false)
    expect(inGraph("ui/settings-pages/index.tsx")).toBe(false)
  })

  test("loads each pane that is not a session or a file when it is first opened", () => {
    for (const pane of [
      "browser/browser-pane.tsx",
      "video/video-pane.tsx",
      "model3d/model-pane.tsx",
      "simulator/simulator-pane.tsx",
      "design/design-pane.tsx",
      "design/design-sheet.tsx",
      "raguverse/raguverse-pane.tsx",
      "editor/file-pane.tsx",
    ]) {
      expect(inGraph(pane)).toBe(false)
    }
  })

  test("still has what the first screen draws and the keys need", () => {
    for (const path of [
      "surface/pane-renderer.tsx",
      "grid/session-grid.tsx",
      "sidebar/sidebar.tsx",
      "terminal/registry.ts",
      "voice/lazy-engine.ts",
      "voice/shortcuts.ts",
      "keyboard/bindings.ts",
    ]) {
      expect(inGraph(path)).toBe(true)
    }
  })
})

describe("the stylesheets that come with the main bundle", () => {
  /*
   * A stylesheet imported only by a lazy chunk is not on the page until the chunk is. The key-request dialog is in the
   * main bundle and opens before the settings panel ever has, and its buttons are the panel's (`settings-choice`): they
   * lost their styles when `sections.css` moved into the panel's chunk.
   */
  test("the key-request dialog brings the settings panel's button styles with it", () => {
    const importers = graph.styles.get(join(ADE_SRC, "settings", "sections.css")) ?? []
    expect(importers.map((file) => relative(ADE_SRC, file).replaceAll("\\", "/"))).toContain("secrets/keys-section.tsx")
  })

  test("nothing in the main bundle imports effect", () => {
    expect(graph.effectImporters.map((file) => relative(ADE_SRC, file))).toEqual([])
  })
})

describe("what the voice package lets the first load take", () => {
  /** The light entry's own closure, walked the same way. */
  const light = walk(join(VOICE_SRC, "light.ts"))
  const relativeNames = [...light.seen].map((file) => relative(VOICE_SRC, file).replaceAll("\\", "/"))

  test("holds neither the engine, nor a speaker, nor a transcriber, nor a capture", () => {
    for (const heavy of [
      "engine.ts",
      "effect/layers.ts",
      "effect/program.ts",
      "effect/services.ts",
      "asr/select.ts",
      "asr/grok-stream.ts",
      "asr/openrouter.ts",
      "audio/capture.ts",
      "audio/meter.ts",
      "tts/natural-speaker.ts",
      "tts/mai-speaker.ts",
      "tts/mai.ts",
      "settings/spend.ts",
      "ui/settings-pages/index.tsx",
    ]) {
      expect(relativeNames).not.toContain(heavy)
    }
  })

  test("does not import effect", () => {
    for (const file of light.seen) {
      for (const { specifier } of staticImports(file, readFileSync(file, "utf8"))) {
        expect(specifier === "effect" || specifier.startsWith("effect/")).toBe(false)
      }
    }
  })
})
