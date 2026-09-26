import { afterEach, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { MAX_PARALLEL_TURNS, SECRET_MARK, acquireTurn, limitReached, scrubSecrets, turnsRunning } from "./terms"

describe("turns on a plan", () => {
  const held: { release: () => void }[] = []
  afterEach(() => held.splice(0).forEach((slot) => slot.release()))

  test("only a few run at once, and a finished one gives its place back", () => {
    for (let i = 0; i < MAX_PARALLEL_TURNS; i++) {
      const slot = acquireTurn("claude", "Claude Code")
      if ("problem" in slot) throw new Error(slot.problem)
      held.push(slot)
    }
    const refused = acquireTurn("claude", "Claude Code")
    expect("problem" in refused && refused.problem).toContain("al massimo")
    held.pop()!.release()
    const again = acquireTurn("claude")
    expect("release" in again).toBe(true)
    if ("release" in again) held.push(again)
  })

  test("releasing twice does not free a second place, and nikcli is not counted", () => {
    const slot = acquireTurn("codex")
    if ("problem" in slot) throw new Error(slot.problem)
    slot.release()
    slot.release()
    expect(turnsRunning("codex")).toBe(0)
    for (let i = 0; i < MAX_PARALLEL_TURNS + 2; i++) expect("release" in acquireTurn("nikcli")).toBe(true)
  })
})

test("an obvious key in a tool's printout is not kept", () => {
  const text = scrubSecrets(
    "trovato sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789 e ghp_abcdefghijklmnopqrstuvwxyz e xai-abcdefghijklmnopqrstuvwxyz",
  )
  expect(text).not.toContain("sk-or-v1-")
  expect(text).not.toContain("ghp_")
  expect(text).not.toContain("xai-")
  expect(text).toContain(SECRET_MARK)
  expect(scrubSecrets("sk-corto e il file limits.ts")).toBe("sk-corto e il file limits.ts")
  const more = [
    `AIza${"a".repeat(35)}`,
    `xoxb-${"1".repeat(12)}`,
    "AKIA1234567890ABCDEF",
    `123456789:${"A".repeat(35)}`,
    `Bearer ${"a".repeat(24)}`,
  ]
  for (const secret of more) expect(scrubSecrets(`visto ${secret} qui`)).not.toContain(secret)
})

test("a plan limit is recognised in what the CLIs say", () => {
  expect(limitReached("Claude AI usage limit reached|1757880000")).toBe(true)
  expect(limitReached("You've hit your usage limit. Upgrade to Pro or try again in 3 hours.")).toBe(true)
  expect(limitReached("stream error: 429 Too Many Requests")).toBe(true)
  expect(limitReached("File not found: limits.ts")).toBe(false)
})

/*
 * The sources are read here, while the file loads, and once each. Read in
 * the test, one read per forbidden string, it took a timeout of 20 s, and
 * that was still not enough right after a checkout: on Windows the first open
 * of a file just written waits for the antivirus, and this is some 360 of
 * them. Loading is not timed per test; the scan is a few milliseconds.
 */
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx|rs)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : []
  })
const root = join(import.meta.dir, "..", "..")
const sources = [...walk(join(root, "src")), ...walk(join(root, "src-tauri", "src"))].map(
  (file) => [file, readFileSync(file, "utf8")] as const,
)

test("ADE's source never touches the CLIs' credentials", () => {
  const forbidden = [".credentials.json", ".codex/auth.json", ".codex\\auth.json", "CLAUDE_CODE_OAUTH_TOKEN"]
  expect(sources.length).toBeGreaterThan(100)
  const hits = sources.filter(([, text]) => forbidden.some((needle) => text.includes(needle))).map(([file]) => file)
  expect(hits).toEqual([])
})
