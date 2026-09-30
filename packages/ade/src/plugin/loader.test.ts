/**
 * The loader is closed, and this is what keeps it closed.
 *
 * Three separate things, because they fail in different directions: the
 * refusal itself, on a plugin the project actually declares; the fact that
 * nothing reached the import (the path that would have needed the asset
 * protocol); and the two files where enabling that protocol would be a
 * decision, so it cannot happen by editing Rust or the config without this
 * test going red. The fourth is the consent dialog in the workbench, which
 * would otherwise still open for code that never runs.
 */
import { describe, expect, test, mock } from "bun:test"
import { readFileSync } from "node:fs"
import type { DiscoveryIO } from "./discovery"
import { FILE_PLUGIN_DISABLED_REASON, importPluginModule } from "./loader"
import { createAdePluginRuntime, type RuntimeHost } from "./runtime"

/** Every path `convertFileSrc` was asked for: none may be there. */
const converted: string[] = []

mock.module("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => {
    converted.push(path)
    return `asset://localhost/${encodeURIComponent(path)}`
  },
  invoke: async () => undefined,
}))

const host: RuntimeHost = {
  data: {
    project: () => ({ name: "nikcli", root: "C:/repo" }),
    session: { list: () => [], get: () => undefined, focused: () => undefined },
  },
  showPalette: () => {},
  onPaneOpened: () => {},
  onPaneClosed: () => {},
}

const files = {
  "C:/repo/.nikcli/tui.json": JSON.stringify({ plugin: ["./p.js"] }),
  "C:/repo/p.js": "",
}

const io: DiscoveryIO = {
  async exists(path) {
    return path.replace(/\\/g, "/") in files
  },
  async readTextFile(path) {
    const text = files[path.replace(/\\/g, "/") as keyof typeof files]
    if (text === undefined) throw new Error("ENOENT")
    return { text }
  },
}

describe("the file loader is closed", () => {
  test("a plugin the project declares ends up refused, with the reason on its row", async () => {
    const runtime = createAdePluginRuntime({ host, io, load: importPluginModule })

    await runtime.start("C:/repo")

    expect(runtime.status()).toEqual([
      { id: "./p.js", spec: "./p.js", source: "file", active: false, error: FILE_PLUGIN_DISABLED_REASON },
    ])
    expect(converted).toEqual([])
  })

  test("importPluginModule refuses without touching the import", async () => {
    await expect(importPluginModule("file:///C:/repo/p.js")).rejects.toThrow(FILE_PLUGIN_DISABLED_REASON)
    await expect(importPluginModule("C:/repo/p.js")).rejects.toThrow(FILE_PLUGIN_DISABLED_REASON)
    // The old path asked `convertFileSrc` for a URL first: it never ran.
    expect(converted).toEqual([])
  })
})

describe("the way a plugin file could be opened stays shut", () => {
  /*
   * Two files, two edits, both of which would make the refusal pointless: a
   * Cargo feature or an `assetProtocol` scope is exactly the "enable the
   * protocol" repair this branch refuses to make. The test is here so that
   * repair has to come with a decision, not with a plugin fix.
   */
  test("Cargo.toml and tauri.conf.json carry no asset protocol", () => {
    const cargo = readFileSync(new URL("../../src-tauri/Cargo.toml", import.meta.url), "utf8")
    const conf = readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8")

    expect(cargo).not.toContain("protocol-asset")
    expect(conf.toLowerCase()).not.toContain("assetprotocol")
    expect(conf.toLowerCase()).not.toContain("asset_protocol")
  })

  test("the consent dialog is not asked for code that never runs", () => {
    const source = readFileSync(new URL("../surface/workbench.tsx", import.meta.url), "utf8")
    const trust = source.indexOf("async trust(")
    const guard = source.indexOf("if (FILE_PLUGINS_DISABLED)", trust)
    const ask = source.indexOf("consentQuestion(", trust)

    expect(trust).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(trust)
    expect(ask).toBeGreaterThan(guard)
  })
})
