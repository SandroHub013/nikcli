import { describe, expect, it } from "bun:test"
import { readdirSync } from "fs"
import path from "path"
import {
  BUILT_IN_THEME_IDS,
  canonicalThemeId,
  FALLBACK_THEME,
  FALLBACK_THEME_ID,
  eagerParsedThemeCount,
  eagerParsedThemeIds,
  isBuiltInTheme,
  loadBuiltInTheme,
} from "@tui/context/theme-catalog"
import { TUI_SRC } from "./tui-source"

const THEME_DIR = path.join(TUI_SRC, "context/theme")
const UNUSED = ["arctic", "muted", "osaka-jade", "oxocarbon", "vivid", "zinc"] as const

describe("built-in theme catalog", () => {
  it("parses only the ragu fallback at module load", () => {
    expect(eagerParsedThemeIds()).toEqual([FALLBACK_THEME_ID])
    expect(eagerParsedThemeCount()).toBe(1)
    expect(FALLBACK_THEME_ID).toBe("ragu")
    expect(FALLBACK_THEME).toHaveProperty("theme")
  })

  it("lists every JSON document plus the dim alias, including previously unwired themes", () => {
    const files = readdirSync(THEME_DIR).filter((name) => name.endsWith(".json"))
    expect(files).toHaveLength(148)
    expect(BUILT_IN_THEME_IDS).toHaveLength(files.length + 1)
    expect(BUILT_IN_THEME_IDS).toContain("dim")
    expect(BUILT_IN_THEME_IDS).toContain("shadow")
    for (const id of UNUSED) {
      expect(BUILT_IN_THEME_IDS).toContain(id)
      expect(isBuiltInTheme(id)).toBe(true)
    }
  })

  it("loads a previously unwired theme on demand", async () => {
    const arctic = (await loadBuiltInTheme("arctic")) as { theme?: { primary?: unknown } }
    expect(arctic?.theme?.primary).toBeDefined()
  })

  it("loads a liquidglass theme with distinct dark and light variants", async () => {
    const frost = (await loadBuiltInTheme("liquid-frost")) as {
      theme?: {
        primary?: { dark?: string; light?: string }
        background?: { dark?: string; light?: string }
        text?: { dark?: string; light?: string }
      }
    }
    expect(frost?.theme?.primary?.dark).toBeDefined()
    expect(frost?.theme?.primary?.light).toBeDefined()
    expect(frost?.theme?.primary?.dark).not.toBe(frost?.theme?.primary?.light)
    expect(frost?.theme?.background?.dark).toBe("transparent")
    expect(frost?.theme?.background?.light).toBe("transparent")
    expect(frost?.theme?.text?.dark).toBeDefined()
    expect(frost?.theme?.text?.light).toBeDefined()
    expect(frost?.theme?.text?.dark).not.toBe(frost?.theme?.text?.light)
  })

  it("resolves the dim alias to the shadow document", async () => {
    const dim = (await loadBuiltInTheme("dim")) as { theme?: unknown }
    const shadow = (await loadBuiltInTheme("shadow")) as { theme?: unknown }
    expect(dim?.theme).toEqual(shadow?.theme)
  })

  it("keeps reading the default theme under its old id, nikcli, without listing it twice", async () => {
    expect(readdirSync(THEME_DIR)).toContain("ragu.json")
    expect(readdirSync(THEME_DIR)).not.toContain("nikcli.json")
    expect(isBuiltInTheme("nikcli")).toBe(true)
    expect(canonicalThemeId("nikcli")).toBe("ragu")
    expect(canonicalThemeId("ragu")).toBe("ragu")
    expect(canonicalThemeId("my-own")).toBe("my-own")
    expect(await loadBuiltInTheme("nikcli")).toBe(await loadBuiltInTheme("ragu"))
    expect(BUILT_IN_THEME_IDS).not.toContain("nikcli")
  })

  it("returns undefined for an unknown id", async () => {
    expect(await loadBuiltInTheme("not-a-theme")).toBeUndefined()
    expect(isBuiltInTheme("not-a-theme")).toBe(false)
  })

  it("does not statically import theme JSON from the provider module", async () => {
    const src = await Bun.file(path.join(THEME_DIR, "..", "theme.tsx")).text()
    expect(src).not.toMatch(/from ["']\.\/theme\/[^"']+\.json["']/)
  })
})
