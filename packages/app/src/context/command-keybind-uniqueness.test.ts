import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

/**
 * No two commands may claim the same chord.
 *
 * The registry deduplicates by command *id*, not by keybind, so two commands can
 * both declare one and only the first registration fires. The other keeps its
 * palette entry and its tooltip, both advertising a shortcut that does nothing —
 * which is how `mod+shift+s` ended up on both `session.new` and
 * `theme.scheme.cycle`, and `shift+mod+d` on the model variant cycle and the
 * visual editor's design mode.
 *
 * Source scanning rather than runtime registration: the commands are assembled
 * from several contexts that need a mounted app, and the collisions are all
 * visible as literals.
 */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return walk(path)
    return path.endsWith(".tsx") || path.endsWith(".ts") ? [path] : []
  })
}

// `pathname` on a file URL is percent-encoded, so a checkout under a path with a
// space or a non-ASCII character would make `readdirSync` throw.
const root = fileURLToPath(new URL("../", import.meta.url))

const declared = walk(root).flatMap((path) => {
  const source = readFileSync(path, "utf8")
  return [...source.matchAll(/keybind:\s*"([^"]+)"/g)].map((match) => ({
    keybind: match[1]!,
    file: path.slice(root.length).split("\\").join("/"),
  }))
})

/**
 * The palette is bound outside the registry — `handleKeyDown` checks it first and
 * returns — so a command that claimed the same chord would be permanently dead
 * while still advertising itself. It is not written as `keybind:`, so the scan
 * above cannot see it and it is added by hand.
 */
const PALETTE_DEFAULT = "mod+shift+p"
const declarations = [...declared, { keybind: PALETTE_DEFAULT, file: "context/command.tsx (palette)" }]

/**
 * The chord as the keymap sees it, on one platform.
 *
 * `signatureFromEvent` reduces a press to `key:mask`, so the order the modifiers
 * were typed in is not part of the identity. Neither is the *spelling* of `mod`:
 * `parseKeybind` resolves it to meta on macOS and to ctrl everywhere else, which
 * makes `mod+l` and `ctrl+l` the same keystroke on Windows and Linux. Comparing
 * raw strings called that a non-collision — and an earlier version of this file
 * asserted it as correct.
 */
function normalizeChord(keybind: string, mac: boolean): string {
  const parts = keybind.split("+").filter(Boolean)
  const key = keybind.endsWith("+") ? "+" : parts.pop()!
  const modifiers = parts.map((part) => {
    const name = part.toLowerCase()
    if (name === "mod") return mac ? "meta" : "ctrl"
    if (name === "cmd" || name === "command") return "meta"
    if (name === "option") return "alt"
    return name
  })
  return [...new Set(modifiers)].sort().concat(key.toLowerCase()).join("+")
}

describe("command keybinds", () => {
  test("the scan found every registration", () => {
    // Pinned to the real count rather than a floor: registrations refactored
    // into constants vanish from the scan, and a floor would not notice.
    expect(declared).toHaveLength(35)
  })

  test.each([
    ["macOS", true],
    ["Windows and Linux", false],
  ])("no chord is claimed twice on %s", (_platform, mac) => {
    const byChord = new Map<string, string[]>()
    for (const entry of declarations) {
      const chord = normalizeChord(entry.keybind, mac)
      byChord.set(chord, [...(byChord.get(chord) ?? []), `${entry.keybind} (${entry.file})`])
    }
    const clashes = [...byChord.entries()]
      .filter(([, where]) => where.length > 1)
      .map(([chord, where]) => `${chord}: ${where.join(" vs ")}`)
    expect(clashes).toEqual([])
  })

  test("mod and ctrl are the same chord off macOS, and different on it", () => {
    expect(normalizeChord("mod+l", false)).toBe(normalizeChord("ctrl+l", false))
    expect(normalizeChord("mod+l", true)).not.toBe(normalizeChord("ctrl+l", true))
  })

  test("modifier order and spelling do not make two chords out of one", () => {
    expect(normalizeChord("shift+mod+d", true)).toBe(normalizeChord("mod+shift+d", true))
    expect(normalizeChord("ctrl+alt+t", false)).toBe(normalizeChord("alt+ctrl+t", false))
    expect(normalizeChord("MOD+Shift+O", false)).toBe(normalizeChord("mod+shift+o", false))
    expect(normalizeChord("cmd+k", true)).toBe(normalizeChord("mod+k", true))
    expect(normalizeChord("option+x", false)).toBe(normalizeChord("alt+x", false))
  })

  test("genuinely different chords stay apart", () => {
    expect(normalizeChord("mod+shift+d", false)).not.toBe(normalizeChord("mod+d", false))
    expect(normalizeChord("mod+shift+d", false)).not.toBe(normalizeChord("mod+shift+e", false))
  })

  test("a key that is itself a modifier character survives the split", () => {
    expect(normalizeChord("mod++", false)).toBe("ctrl++")
    expect(normalizeChord("mod+.", false)).toBe("ctrl+.")
  })
})
