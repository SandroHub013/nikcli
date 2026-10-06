/**
 * Shutdown must not be able to keep nikcli alive.
 *
 * The benchmark lost one run in 271 to a `nikcli run` that outlived the model by 22 minutes, and the
 * last line it ever logged was `disposing herdr plugin`, which made the herdr plugin the obvious
 * suspect. It is not: see REPORT.md. What these tests pin is the contract the fix rests on — a
 * shutdown with the bridge off does no work at all, and the synchronous release is bounded.
 *
 * Every assertion races a timer, so a regression fails the test instead of hanging the suite.
 */
import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import * as bridge from "@nikcli-ai/util/herdr-bridge"

const originalEnv = { ...process.env }
const WINDOWS = process.platform === "win32"

/** Fail rather than hang: a regression here has to surface as a failed assertion. */
function within<T>(ms: number, work: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`shutdown did not return within ${ms}ms`)), ms)
  })
  return Promise.race([Promise.resolve().then(work), guard]).finally(() => clearTimeout(timer)) as Promise<T>
}

/** A `herdr` that takes the release command and then never answers. */
function hangingHerdr(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "nikcli-fake-herdr-"))
  const file = path.join(dir, "herdr")
  writeFileSync(file, `#!/bin/sh\nsleep 120\n`)
  chmodSync(file, 0o755)
  return file
}

afterEach(() => {
  process.env = { ...originalEnv }
  bridge.setReleased(false)
})

describe("herdr shutdown", () => {
  it("does no work at all when the bridge was never in a pane", async () => {
    // The real fix. `resolveHerdrBin` is a synchronous PATH walk, and it used to run on the way out
    // of *every* session, including the ~all of them that are not running under Herdr. Counting
    // `Bun.which` calls is the only way to see it: the guard reads an env var, the walk touches the
    // filesystem, and the difference is invisible from the return value.
    delete process.env.HERDR_PANE_ID
    delete process.env.HERDR_BIN_PATH

    const original = Bun.which
    let walks = 0
    Bun.which = ((...args: Parameters<typeof original>) => {
      walks++
      return original(...args)
    }) as typeof original
    try {
      await within(2000, () => bridge.releasePaneSync())
    } finally {
      Bun.which = original
    }
    expect(walks).toBe(0)
  })

  it("is a no-op through stop() + release when the bridge is off", async () => {
    delete process.env.HERDR_PANE_ID
    delete process.env.HERDR_BIN_PATH
    bridge.stop()
    await expect(within(2000, () => bridge.releasePaneSync())).resolves.toBeUndefined()
  })

  it("gives up on a herdr that never answers", async () => {
    // The release is a courtesy to herdr's agent panel — the row clears itself when the pane's shell
    // exits — so a wedged `herdr` may cost nikcli the caller's 2s budget and nothing more. It may not
    // cost nikcli its exit.
    process.env.HERDR_PANE_ID = "w1:p1"
    process.env.HERDR_BIN_PATH = hangingHerdr()
    bridge.setReleased(false)

    const started = Date.now()
    await within(12_000, () => bridge.releasePaneSync())
    // Generous: the bound that matters is "seconds, not the 1,500s the harness waits".
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 20_000)

  it("never blocks or throws when the release cannot be spawned", async () => {
    // On Windows `spawnSync` refuses a `.cmd` outright (EINVAL) unless the caller opts into
    // `shell: true`, which the release deliberately does not: a pane id from the environment is not
    // something to hand to a shell. So on this platform the spawn fails immediately and the failure
    // has to stay contained. See REPORT.md — it also means a `.cmd` herdr never gets released, which
    // is a gap in the feature, not a hang.
    process.env.HERDR_PANE_ID = "w1:p1"
    process.env.HERDR_BIN_PATH = path.join(mkdtempSync(path.join(tmpdir(), "nikcli-no-herdr-")), "absent")
    bridge.setReleased(false)

    const started = Date.now()
    await expect(within(5000, () => bridge.releasePaneSync())).resolves.toBeUndefined()
    expect(Date.now() - started).toBeLessThan(2000)
  }, 15_000)

  it("only releases once, so a second shutdown path cannot repeat the work", async () => {
    process.env.HERDR_PANE_ID = "w1:p1"
    process.env.HERDR_BIN_PATH = path.join(mkdtempSync(path.join(tmpdir(), "nikcli-no-herdr2-")), "absent")
    bridge.setReleased(false)

    await within(5000, () => bridge.releasePaneSync())
    const started = Date.now()
    await expect(within(1000, () => bridge.releasePaneSync())).resolves.toBeUndefined()
    expect(Date.now() - started).toBeLessThan(500)
  }, 15_000)

  it("still hands the pane back under the source herdr granted authority to", () => {
    // Unchanged contract: the source label is what herdr matches on.
    expect(bridge.releaseAgentArgv("w1:p1", 42)).toEqual([
      "pane",
      "release-agent",
      "w1:p1",
      "--source",
      "herdr:nikcli",
      "--agent",
      "nikcli",
      "--seq",
      "42",
    ])
  })
})

describe("platform note", () => {
  it("records which spawn behaviour these tests actually exercised", () => {
    // Not an assertion about behaviour — a note so a Windows reader does not read the hanging-herdr
    // test as coverage it does not have.
    expect(WINDOWS).toBe(process.platform === "win32")
  })
})
