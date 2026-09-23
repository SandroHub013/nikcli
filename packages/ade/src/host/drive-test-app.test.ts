import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { join } from "node:path"

import { BUILD_CHECK, buildRefusal, buildVerdict, cellCenter, chooseCdpPort, modifierBits, notListening, parseArgs, pickPage, usage } from "./drive-test-app"

describe("chooseCdpPort", () => {
  test("CDP_PORT wins, and must be a port", () => {
    expect(chooseCdpPort("9528", { port: 5528, cdpPort: 9999, label: "x", root: "r" })).toEqual({ port: 9528, source: "CDP_PORT" })
    expect(chooseCdpPort("nove", undefined)).toContain("non è una porta")
    expect(chooseCdpPort("70000", undefined)).toContain("non è una porta")
  })

  test("else the worktree's record, and only one started with --cdp", () => {
    expect(chooseCdpPort(undefined, { port: 5528, cdpPort: 9528, label: "x", root: "r" })).toEqual({ port: 9528, source: "record" })
    expect(chooseCdpPort("", { port: 5528, label: "x", root: "r" })).toContain("senza --cdp")
    expect(chooseCdpPort(undefined, undefined)).toContain("nessuna ADE Test registrata")
  })
})

describe("pickPage", () => {
  test("takes the page target and nothing else", () => {
    const page = { type: "page", url: "http://localhost:5528/", webSocketDebuggerUrl: "ws://127.0.0.1:9528/devtools/page/1" }
    expect(pickPage([{ type: "service_worker", webSocketDebuggerUrl: "ws://x" }, page])).toBe(page)
    expect(pickPage([{ type: "page" }])).toContain("nessuna finestra")
    expect(pickPage({ error: 1 })).toContain("non è un elenco")
  })
})

describe("the build check", () => {
  /** `dev.tsx` marks a test build and nothing marks the official one. */
  test("drives a test build only, and tells loading from another ADE", () => {
    expect(buildVerdict({ build: "test", workbench: true })).toBe("test")
    expect(buildVerdict({ build: "test", workbench: false })).toBe("test")
    // No mark yet: ask again, even with the workbench up — it renders before the mark lands.
    expect(buildVerdict({ build: null, workbench: false })).toBe("waiting")
    expect(buildVerdict({ build: null, workbench: true })).toBe("waiting")
    expect(buildVerdict(undefined)).toBe("waiting")
    // The wait is over: a workbench still without the mark is another ADE; no workbench is still loading.
    expect(buildVerdict({ build: null, workbench: true }, true)).toBe("other")
    expect(buildVerdict({ build: null, workbench: false }, true)).toBe("waiting")
    // A foreign mark is another build at once.
    expect(buildVerdict({ build: "prod", workbench: false })).toBe("other")
    expect(BUILD_CHECK).toContain("adeBuild")
    expect(BUILD_CHECK).toContain("ade-bar")
  })

  test("the two refusals are different sentences, and the hard one stays hard", () => {
    expect(buildRefusal("waiting")).toContain("sto ancora aspettando")
    expect(buildRefusal("waiting")).not.toContain("ufficiale")
    expect(buildRefusal("other", { build: null, workbench: true })).toContain("non si guida ADE ufficiale, nemmeno per sbaglio")
    expect(buildRefusal("other", { build: "prod" })).toContain("un'altra ADE, non la guido")
  })
})

describe("parseArgs", () => {
  test("each command with its argument", () => {
    expect(parseArgs(["panes"])).toEqual({ command: "panes", rest: "" })
    expect(parseArgs(["type", "2", "ciao", "mondo"])).toEqual({ command: "type", pane: 2, rest: "ciao mondo" })
    expect(parseArgs(["key", "1", "Escape"])).toEqual({ command: "key", pane: 1, rest: "Escape" })
    expect(parseArgs(["shot", "out.png"])).toEqual({ command: "shot", rest: "out.png" })
  })

  test("says what is missing", () => {
    expect(parseArgs([])).toBe(usage())
    expect(parseArgs(["fly"])).toBe(usage())
    expect(parseArgs(["text", "zero"])).toContain("indice del pannello")
    expect(parseArgs(["type", "1"])).toContain("manca il testo")
    expect(parseArgs(["shot"])).toContain("manca l'argomento")
  })
})

describe("the script without an ADE Test listening", () => {
  /**
   * Master's condition: it starts, and fails well, when nothing listens. Port 1
   * is refused at once on every machine; the timeout in the script bounds the
   * other case (a port that swallows the knock) to a few seconds.
   */
  test("exits 1 with the port and the remedy, within the timeout", () => {
    const script = join(import.meta.dir, "..", "..", "scripts", "drive-test-app.ts")
    const started = Date.now()
    const run = spawnSync("bun", [script, "panes"], { encoding: "utf8", env: { ...process.env, CDP_PORT: "1" }, timeout: 15_000 })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain("ADE Test non risponde su 127.0.0.1:1")
    expect(run.stderr).toContain("test:app --cdp")
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  test("the message names what was tried", () => {
    expect(notListening({ port: 9528, source: "record" }, "ECONNREFUSED")).toContain("dal record di questa worktree")
    expect(notListening({ port: 9528, source: "CDP_PORT" }, "x")).toContain("CDP_PORT=9528")
  })
})

describe("the mouse commands (S76)", () => {
  test("drag takes a row, two columns and an optional alt or shift", () => {
    expect(parseArgs(["drag", "1", "3", "0", "12"])).toEqual({ command: "drag", pane: 1, rest: "", pointer: { row: 3, col: 0, toCol: 12, modifier: undefined } })
    expect(parseArgs(["drag", "2", "0", "4", "9", "alt"])).toMatchObject({ pointer: { modifier: "alt" } })
    expect(parseArgs(["drag", "2", "0", "4", "9", "shift"])).toMatchObject({ pointer: { modifier: "shift" } })
    expect(typeof parseArgs(["drag", "1", "3", "0"])).toBe("string")
    expect(typeof parseArgs(["drag", "1", "3", "0", "5", "ctrl"])).toBe("string")
  })

  test("click takes a row, a column and an optional ctrl or alt", () => {
    expect(parseArgs(["click", "1", "2", "7"])).toEqual({ command: "click", pane: 1, rest: "", pointer: { row: 2, col: 7, toCol: undefined, modifier: undefined } })
    expect(parseArgs(["click", "1", "2", "7", "ctrl"])).toMatchObject({ pointer: { modifier: "ctrl" } })
    expect(typeof parseArgs(["click", "1", "-1", "7"])).toBe("string")
    expect(typeof parseArgs(["click", "1", "2", "7", "shift"])).toBe("string")
  })

  test("key takes Ctrl+V", () => {
    expect(parseArgs(["key", "1", "Ctrl+V"])).toEqual({ command: "key", pane: 1, rest: "Ctrl+V" })
  })

  test("a cell's middle in pixels, and CDP's modifier bits", () => {
    expect(cellCenter({ left: 10, top: 20, width: 800, height: 400 }, 20, 100, 0, 0)).toEqual({ x: 14, y: 30 })
    expect(cellCenter({ left: 10, top: 20, width: 800, height: 400 }, 20, 100, 19, 99)).toEqual({ x: 806, y: 410 })
    expect([modifierBits("alt"), modifierBits("ctrl"), modifierBits("shift"), modifierBits(undefined)]).toEqual([1, 2, 8, 0])
  })
})
