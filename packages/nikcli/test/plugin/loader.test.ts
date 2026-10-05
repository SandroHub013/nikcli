import { describe, expect, it } from "bun:test"
import { removeTestDir } from "../helpers/fs"
import { createHash } from "crypto"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { importPlugin, PluginExitError } from "@nikcli-ai/util/plugin-shared"
import { Flag } from "@nikcli-ai/util/flag"
import { ToolRegistry } from "@/tool/registry"

/**
 * Plugin / custom-tool autoload security (PR-6.1).
 *
 * Full ToolRegistry init is too heavy for a subprocess round-trip in the
 * default unit timeout; the gate helpers below are the security decision
 * surface and are covered directly.
 */
describe("ToolRegistry custom tool autoload security", () => {
  it("sha256 pin digest matches node crypto", () => {
    const payload = "nikcli-tool-pin"
    const expected = createHash("sha256").update(payload).digest("hex")
    const hasher = new Bun.CryptoHasher("sha256")
    hasher.update(payload)
    expect(hasher.digest("hex")).toBe(expected)
  })

  it("defaults NIKCLI_ALLOW_PLUGIN_AUTOLOAD to off", () => {
    const previous = process.env.NIKCLI_ALLOW_PLUGIN_AUTOLOAD
    delete process.env.NIKCLI_ALLOW_PLUGIN_AUTOLOAD
    try {
      expect(Flag.NIKCLI_ALLOW_PLUGIN_AUTOLOAD).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.NIKCLI_ALLOW_PLUGIN_AUTOLOAD
      else process.env.NIKCLI_ALLOW_PLUGIN_AUTOLOAD = previous
    }
  })

  it("shouldScanCustomTools is false when flag off and allowlist empty", () => {
    expect(ToolRegistry.shouldScanCustomTools({ allowAutoloadFlag: false, allowlist: [] })).toBe(false)
  })

  it("shouldScanCustomTools is true when flag on or allowlist set", () => {
    expect(ToolRegistry.shouldScanCustomTools({ allowAutoloadFlag: true, allowlist: [] })).toBe(true)
    expect(ToolRegistry.shouldScanCustomTools({ allowAutoloadFlag: false, allowlist: ["escape.ts"] })).toBe(true)
  })

  it("isCustomToolAllowed matches basename, stem, or absolute path", () => {
    const file = "/tmp/config/tool/escape.ts"
    expect(ToolRegistry.isCustomToolAllowed(file, ["escape.ts"])).toBe(true)
    expect(ToolRegistry.isCustomToolAllowed(file, ["escape"])).toBe(true)
    expect(ToolRegistry.isCustomToolAllowed(file, [file])).toBe(true)
    expect(ToolRegistry.isCustomToolAllowed(file, ["other.ts"])).toBe(false)
  })

  it("customToolPin resolves by absolute path, then basename, then namespace", () => {
    const file = "/tmp/config/tool/escape.ts"
    expect(ToolRegistry.customToolPin({ [file]: "by-path" }, file)).toBe("by-path")
    expect(ToolRegistry.customToolPin({ "escape.ts": "by-base" }, file)).toBe("by-base")
    expect(ToolRegistry.customToolPin({ escape: "by-namespace" }, file)).toBe("by-namespace")
    expect(
      ToolRegistry.customToolPin({ [file]: "by-path", "escape.ts": "by-base", escape: "by-namespace" }, file),
    ).toBe("by-path")
    expect(ToolRegistry.customToolPin({ "other.ts": "unrelated" }, file)).toBeUndefined()
  })

  it("an unpinned file is loadable; the autoload gate is what keeps it out", () => {
    expect(ToolRegistry.isCustomToolPinSatisfied(undefined, "a".repeat(64))).toBe(true)
  })

  it("a declared pin that does not match the file on disk is fail-closed", () => {
    const actual = new Bun.CryptoHasher("sha256").update("nikcli-tool-pin").digest("hex")
    expect(ToolRegistry.isCustomToolPinSatisfied(actual, actual)).toBe(true)
    expect(ToolRegistry.isCustomToolPinSatisfied(actual.toUpperCase(), actual)).toBe(true)
    expect(ToolRegistry.isCustomToolPinSatisfied(actual.replace(/.$/, "0"), actual)).toBe(false)
    expect(ToolRegistry.isCustomToolPinSatisfied("", actual)).toBe(true)
  })
})

describe("importPlugin", () => {
  // A stray script in a plugin directory (every .ts there is loaded) used to
  // end the whole CLI at startup by calling process.exit when run without args.
  async function pluginDir(files: Record<string, string>) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-plugin-exit-"))
    for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body)
    return dir
  }

  it("refuses process.exit from a plugin while it loads, and restores process.exit", async () => {
    const dir = await pluginDir({ "probe.ts": "await Bun.sleep(5)\nprocess.exit(2)\n" })
    const exit = process.exit
    try {
      const file = pathToFileURL(path.join(dir, "probe.ts")).href
      const error = await importPlugin(file, file).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(PluginExitError)
      expect((error as PluginExitError).code).toBe(2)
      expect(process.exit).toBe(exit)
    } finally {
      await removeTestDir(dir)
    }
  })

  it("still lets anything else end the process while a plugin loads", async () => {
    const dir = await pluginDir({ "slow.ts": "await Bun.sleep(50)\nexport default {}\n" })
    const exit = process.exit
    const calls: unknown[] = []
    process.exit = ((code?: number) => {
      calls.push(code)
      return undefined as never
    }) as typeof process.exit
    try {
      const file = pathToFileURL(path.join(dir, "slow.ts")).href
      const loading = importPlugin(file, file)
      // The user quitting mid-load: not the plugin's call, so it goes through.
      process.exit(0)
      await loading
      expect(calls).toEqual([0])
    } finally {
      process.exit = exit
      await removeTestDir(dir)
    }
  })

  it("keeps guarding a directory while another plugin from it is still loading", async () => {
    const dir = await pluginDir({
      "fast.ts": "export default {}\n",
      "late.ts": "await Bun.sleep(30)\nprocess.exit(3)\n",
    })
    try {
      const fast = pathToFileURL(path.join(dir, "fast.ts")).href
      const late = pathToFileURL(path.join(dir, "late.ts")).href
      const [, error] = await Promise.all([importPlugin(fast, fast), importPlugin(late, late).catch((e: unknown) => e)])
      expect(error).toBeInstanceOf(PluginExitError)
    } finally {
      await removeTestDir(dir)
    }
  })
})
