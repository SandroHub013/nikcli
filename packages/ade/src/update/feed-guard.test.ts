import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { feedDecision } from "../../script/feed-guard"

/*
 * Full review 2026-10-06, ui 7: `ade-release` overwrote `ade-updater/latest.json` with no look at its
 * version, so an old tag re-run, or two tags side by side, took the update away from installed copies.
 */
const feed = (version: unknown) => JSON.stringify({ version, platforms: {} })

describe("the updater's feed is never moved back", () => {
  test("a newer version replaces it, across every position of the number", () => {
    expect(feedDecision(feed("0.12.0"), "0.12.1")).toBe("write")
    expect(feedDecision(feed("0.12.9"), "0.13.0")).toBe("write")
    expect(feedDecision(feed("0.12.9"), "1.0.0")).toBe("write")
    expect(feedDecision(feed("0.9.0"), "0.10.0")).toBe("write")
  })

  test("an older one is skipped, with the version that stays", () => {
    for (const [current, candidate] of [
      ["0.12.0", "0.11.0"],
      ["0.12.1", "0.12.0"],
      ["1.0.0", "0.99.99"],
      ["0.10.0", "0.9.0"],
    ] as const) {
      const decision = feedDecision(feed(current), candidate)
      expect(decision.startsWith("skip")).toBe(true)
      expect(decision).toContain(current)
    }
  })

  test("the same version is written again: a rerun of the newest release", () => {
    expect(feedDecision(feed("0.12.0"), "0.12.0")).toBe("write")
  })

  test("with no feed yet, it is written", () => {
    expect(feedDecision(undefined, "0.1.0")).toBe("write")
  })

  test("a feed nobody can read is replaced", () => {
    for (const text of ["", "not json", "{}", feed(""), feed("latest"), feed(12), "null", "[]"])
      expect(feedDecision(text, "0.12.0")).toBe("write")
  })

  test("a version to release that is not x.y.z is never written", () => {
    for (const bad of ["", "v0.12.0", "0.12", "0.12.0-rc1", "ade-v0.12.0"])
      expect(feedDecision(feed("0.1.0"), bad).startsWith("skip")).toBe(true)
  })

  test("the script says it on stdout, and reads `-` as no feed", () => {
    const script = join(import.meta.dir, "..", "..", "script", "feed-guard.ts")
    const run = (...args: string[]) =>
      Bun.spawnSync([process.execPath, script, ...args], { stdout: "pipe", stderr: "pipe" })
    expect(run("-", "0.1.0").stdout.toString().trim()).toBe("write")
    expect(run("-").exitCode).toBe(2)
  })
})
