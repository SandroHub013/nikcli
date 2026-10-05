import { preserveTestEnv } from "../helpers/env"
import { removeTestDir } from "../helpers/fs"
import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test"
import realfs from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-reload-headless-home-"))
process.env.NIKCLI_TEST_HOME = testHome
process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1"

preserveTestEnv(["NIKCLI_TEST_HOME", "NIKCLI_DISABLE_PROJECT_CONFIG"])

const { Instance } = await import("@/project/instance")
const { InstanceReload } = await import("@/project/reload")
const { Bus } = await import("@/bus")

const created: string[] = []

/**
 * `watch()` watches parent directories, so a project config file is watched
 * through its directory — the one target that exists in a bare temp dir, and
 * the one whose filename filter (`nikcli.json` only) a stray write cannot slip
 * past.
 */
async function directory(label: string) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `nikcli-reload-${label}-`)))
  created.push(dir)
  await fs.writeFile(path.join(dir, "nikcli.json"), JSON.stringify({ agent: { alpha: { prompt: "a" } } }))
  return dir
}

function context(directory: string) {
  // SAFETY: `watch` reads `directory` and `worktree` off the context and
  // reaches everything else through the ambient instance scope.
  return { directory, worktree: directory, project: { id: "test" } } as never
}

/**
 * Counts the watchers `watch()` opens and closes for one temp directory.
 *
 * A behavioural assertion cannot tell a closed watcher from an open one whose
 * `flush` bailed on `Instance.has` — and that bail is exactly what a disposed
 * instance gets for free. So the handles themselves are what this pins. The
 * count is scoped to this test's directory because `fs` is process-wide and
 * `bun test` shares one process across files: an unrelated watcher armed by
 * another test would otherwise land in the tally.
 */
function trackWatchers(scope: string) {
  const opened: realfs.FSWatcher[] = []
  let closed = 0
  const watch = realfs.watch
  // SAFETY: the wrapper is `watch` with a counting `close` grafted onto the
  // watchers it returns; the overload set is wider than any single call site.
  spyOn(realfs, "watch").mockImplementation(((...args: unknown[]) => {
    const watcher = watch(...(args as [never, never]))
    if (String(args[0]).includes(scope)) {
      opened.push(watcher)
      const close = watcher.close.bind(watcher)
      watcher.close = () => {
        closed++
        return close()
      }
    }
    return watcher
  }) as unknown as typeof watch)
  return {
    get opened() {
      return opened.length
    },
    get closed() {
      return closed
    },
  }
}

/** Long enough for `DEBOUNCE_MS` (300) to flush and the reload to announce. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 600))
}

afterEach(() => {
  // `spyOn` installs on the shared `fs` module, and `bun test` shares one
  // process across files: left in place it would re-wrap an already-wrapped
  // `watch` for every later test.
  ;(realfs.watch as unknown as { mockRestore?: () => void }).mockRestore?.()
})

afterAll(async () => {
  await Instance.disposeAll()
  for (const dir of created) await removeTestDir(dir)
  await removeTestDir(testHome)
})

describe("InstanceReload.watch — teardown", () => {
  it(
    "closes every watcher it opened when stopped",
    async () => {
      const dir = await directory("stop")
      const watchers = trackWatchers(path.basename(dir))

      let stop = () => {}
      let armed: boolean | undefined
      let afterStop: boolean | undefined
      try {
        const seen = await Instance.provide({
          directory: dir,
          fn: async () => {
            const events: string[] = []
            const unsubscribe = Bus.subscribeAll((event) => {
              events.push(event.type)
            })
            try {
              stop = await InstanceReload.watch(context(dir))

              // Armed, or the half of the assertion below is vacuous.
              await fs.writeFile(path.join(dir, "nikcli.json"), JSON.stringify({ agent: { beta: { prompt: "b" } } }))
              await settle()
              armed = events.includes(InstanceReload.Event.Started.type)

              stop()
              events.length = 0

              await fs.writeFile(path.join(dir, "nikcli.json"), JSON.stringify({ agent: { gamma: { prompt: "g" } } }))
              await settle()
              afterStop = events.includes(InstanceReload.Event.Started.type)
              return { armed, afterStop }
            } finally {
              unsubscribe()
            }
          },
        })
        armed = seen.armed
        afterStop = seen.afterStop
      } finally {
        stop()
        await Instance.provide({ directory: dir, fn: () => Instance.dispose() }).catch(() => {})
      }

      expect(armed).toBe(true)
      expect(afterStop).toBe(false)
      // The instance was never disposed while the watchers were open, so the
      // `stop` function is the only thing that could have closed them.
      expect(watchers.opened).toBeGreaterThan(0)
      expect(watchers.closed).toBe(watchers.opened)
    },
    // The first `watch()` in the process builds the config layer, and the
    // reload pulls in `@/plugin`; the default 5s budget does not cover it.
    30000,
  )

  it("closes the watchers when dispose arrives before watch() resolves", async () => {
    const dir = await directory("late-dispose")
    const watchers = trackWatchers(path.basename(dir))

    await Instance.provide({
      directory: dir,
      fn: async () => {
        // The shape `project/bootstrap.ts` uses, and the ordering that breaks
        // it: teardown lands while `watch` is still resolving its config
        // directories, so the disposer is registered against an instance that
        // has already walked its disposer set. `registerDisposer` runs a late
        // registration immediately — this is what says the watchers end up
        // closed rather than merely unreferenced.
        const armed = InstanceReload.watch(context(dir)).then((stop) => Instance.registerDisposer(stop))
        await Instance.dispose()
        await armed
      },
    })

    expect(watchers.opened).toBeGreaterThan(0)
    expect(watchers.closed).toBe(watchers.opened)
  })
})

/**
 * The policy is process-wide and one-way, like the `NIKCLI_HEADLESS` posture it
 * follows: `nikcli run` decides before the instance is bootstrapped, and
 * nothing turns it back on. So the opt-out is read last.
 *
 * `NIKCLI_DISABLE_HOT_RELOAD` is deliberately absent: it is captured at module
 * load in `packages/util`, so a test could only read it by spawning a
 * process, and what it suppresses here is unchanged by this commit.
 */
describe("InstanceReload.watching", () => {
  it("watches the config unless something says otherwise", () => {
    expect(InstanceReload.watching()).toBe(true)
  })

  it("stops watching once a headless run opts out", () => {
    InstanceReload.disableForHeadlessRun()
    expect(InstanceReload.watching()).toBe(false)
  })
})