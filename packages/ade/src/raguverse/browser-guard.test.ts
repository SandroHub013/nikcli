import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import {
  browserProcesses,
  isAlive,
  killByProfile,
  type BrowserProcess,
  type KillDeps,
  killTree,
  namesProfile,
  newProfile,
  ownerOf,
  profilesDir,
  sweepOrphans,
} from "./browser-guard"

/**
 * A browser the script started must not outlive it: not on a normal end, not on an error, not when the script is killed
 * hard (which runs nothing of its own), and not when the process the script started was only a launcher that handed over to
 * the real browser and exited (Edge's, on this machine: it made 244 orphans). One that a hard kill did leave is taken at the
 * next start. These use a stand-in for the browser (a `bun` with a `--user-data-dir` naming the profile) so they run
 * anywhere; the last one uses the real Edge.
 */

// Each one starts real processes and waits on WMI, which answers in a second or two.
setDefaultTimeout(60_000)

/**
 * The tests that start processes (the stand-in, and the real Edge) take about a minute and wait on WMI, which answers late under
 * load: they are out of `test:unit` and run with `NIKVERSE_GUARD_TESTS=1`, which the gate does (its «browser guard» check).
 */
const processes = process.env.NIKVERSE_GUARD_TESTS === "1"

const packageRoot = join(import.meta.dir, "..", "..")
const scratch = join(profilesDir(packageRoot), "test-guard")
const owner = join(import.meta.dir, "browser-guard-owner.fixture.ts")
const dummy = join(import.meta.dir, "browser-guard-dummy.fixture.ts")
const spawned: number[] = []
const profiles = new Set<string>()

afterAll(() => {
  for (const profile of profiles) killByProfile(profile, "bun")
  for (const pid of spawned) killTree(pid)
  rmSync(scratch, { recursive: true, force: true })
})

const waitFor = async (condition: () => boolean, ms: number) => {
  const end = Date.now() + ms
  while (Date.now() < end && !condition()) await Bun.sleep(100)
  return condition()
}

/**
 * How long the real Edge's processes may take to go after their script, on a machine that is busy (the gate runs this beside a browser
 * of its own): a deadline on the thing itself going, and the wait ends the moment it has.
 */
const HELPERS_GONE_MS = 30_000

/** True when `condition` held at every look for `ms`; false at the first look it did not. */
const staysTrue = async (condition: () => boolean, ms: number) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (!condition()) return false
    await Bun.sleep(100)
  }
  return condition()
}

/** Is any process of the stand-in browser of this profile alive? */
const standInAlive = (profile: string, program = "bun") =>
  browserProcesses(program).some((p) => namesProfile(p.commandLine, profile))

/** Reads the owner script's stdout until it has said what it launched. */
async function saidLaunched(child: ReturnType<typeof Bun.spawn>, what: string) {
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader()
  let text = ""
  while (!text.includes(what)) {
    const { value, done } = await reader.read()
    if (done) break
    text += new TextDecoder().decode(value)
  }
  return text
}

/** Runs the owner script; resolves once its stand-in browser is up. */
async function run(mode: string) {
  const child = Bun.spawn([process.execPath, owner, mode, scratch], { stdout: "pipe", stderr: "ignore" })
  spawned.push(child.pid)
  const match = /launched (\d+) profile (.+?)\r?\n/.exec(await saidLaunched(child, "\n"))
  if (!match) throw new Error("the owner said nothing")
  const profile = match[2]
  profiles.add(profile)
  // The stand-in is listed by WMI a moment after it starts, and a launcher's real browser a moment after that.
  expect(await waitFor(() => standInAlive(profile), 15_000)).toBe(true)
  return { child, profile }
}

describe("the profile", () => {
  test("lives under the package's .ade-test, inside Favorites, and carries the owner's pid", () => {
    const profile = newProfile(scratch)
    expect(profile.startsWith(join(packageRoot, ".ade-test"))).toBe(true)
    expect(profile.toLowerCase()).not.toContain("temp")
    expect(ownerOf(`msedge.exe --user-data-dir="${profile}" --type=gpu-process`)).toBe(process.pid)
    rmSync(profile, { recursive: true, force: true })
  })

  test("ownerOf reads the pid from any folder, and nothing from a browser that is not ours", () => {
    expect(ownerOf(`--user-data-dir=C:\\Users\\x\\AppData\\Local\\Temp\\nikverse-browser-4242 --headless=new`)).toBe(
      4242,
    )
    expect(ownerOf("--user-data-dir=/tmp/nikverse-browser-77")).toBe(77)
    expect(ownerOf("msedge.exe --user-data-dir=C:\\Users\\x\\edge-profile")).toBeUndefined()
    expect(ownerOf("--user-data-dir=/tmp/nikverse-browser-old")).toBeUndefined()
  })

  test("a profile is named exactly: the one of pid 123 is not the one of pid 1234", () => {
    expect(
      namesProfile('msedge.exe --user-data-dir="C:\\a\\nikverse-browser-123" --x', "C:\\a\\nikverse-browser-123"),
    ).toBe(true)
    expect(namesProfile("msedge.exe --user-data-dir=C:\\a\\nikverse-browser-123", "c:\\a\\NIKVERSE-browser-123")).toBe(
      true,
    )
    expect(
      namesProfile("msedge.exe --user-data-dir=C:\\a\\nikverse-browser-1234 --x", "C:\\a\\nikverse-browser-123"),
    ).toBe(false)
  })
})

/** A browser whose helpers stay listed for a while after they are killed, or come back: what Edge's GPU process does. */
function slowBrowser(profile: string, stillListedAfter: number) {
  let kills = 0
  let clock = 0
  const log: number[][] = []
  const deps: KillDeps = {
    list: () =>
      kills >= stillListedAfter
        ? []
        : [
            {
              pid: 1,
              commandLine: `msedge.exe --user-data-dir=${profile} --type=gpu-process`,
            } satisfies BrowserProcess,
          ],
    kill: (...pids) => {
      kills++
      log.push(pids)
    },
    now: () => clock,
    pause: (ms) => {
      clock += ms
    },
  }
  return { deps, kills: () => kills, log }
}

describe("killing a browser by its profile waits for the last helper to be gone, and says whether it is", () => {
  const profile = "C:/a/nikverse-browser-123"

  test("a helper that is still listed after four kills is killed again: the count of passes is not what ends it", () => {
    // Edge's GPU process: listed for a while after it is killed, or started again as the browser goes.
    const browser = slowBrowser(profile, 6)
    expect(killByProfile(profile, undefined, 10_000, browser.deps)).toBe(true)
    expect(browser.kills()).toBe(6)
  })

  test("nothing listed is nothing to do, and no pause", () => {
    const browser = slowBrowser(profile, 0)
    expect(killByProfile(profile, undefined, 10_000, browser.deps)).toBe(true)
    expect(browser.kills()).toBe(0)
  })

  test("a helper that never goes ends at the deadline and says so", () => {
    const browser = slowBrowser(profile, Infinity)
    expect(killByProfile(profile, undefined, 1000, browser.deps)).toBe(false)
    // Killed over and over until the time was up, with a pause between the tries.
    expect(browser.kills()).toBeGreaterThan(5)
  })

  test("it only takes what names this profile", () => {
    const killed: number[][] = []
    let listed = 2
    const deps: KillDeps = {
      list: () =>
        listed-- > 0
          ? [
              { pid: 7, commandLine: `msedge.exe --user-data-dir=${profile}` },
              { pid: 8, commandLine: "msedge.exe --user-data-dir=C:/a/nikverse-browser-1234" },
            ]
          : [],
      kill: (...pids) => void killed.push(pids),
      now: () => 0,
      pause: () => {},
    }
    expect(killByProfile(profile, undefined, 1000, deps)).toBe(true)
    expect(killed.flat()).toEqual([7, 7])
  })
})

describe.skipIf(!processes)("the browser does not survive its script", () => {
  test("a script that closes its browser leaves none, nor its profile", async () => {
    const { child, profile } = await run("close")
    await child.exited
    expect(standInAlive(profile)).toBe(false)
    expect(existsSync(profile)).toBe(false)
  })

  test("a script that leaves by process.exit without closing", async () => {
    const { child, profile } = await run("exit")
    await child.exited
    expect(await waitFor(() => !standInAlive(profile), 5000)).toBe(true)
  })

  test("a script that fails with the browser open", async () => {
    const { child, profile } = await run("throw")
    await child.exited
    expect(await waitFor(() => !standInAlive(profile), 5000)).toBe(true)
  })

  test("a script killed hard (nothing of its own runs): the watchdog takes the browser and the profile", async () => {
    const { child, profile } = await run("hang")
    child.kill("SIGKILL")
    await child.exited
    expect(await waitFor(() => !standInAlive(profile) && !existsSync(profile), 20_000)).toBe(true)
  })

  test("the process the script started is only a launcher, gone at once: closing still takes the real browser", async () => {
    const { child, profile } = await run("close+launcher")
    await child.exited
    expect(standInAlive(profile)).toBe(false)
  })

  test("the same, when the script ends without closing", async () => {
    const { child, profile } = await run("exit+launcher")
    await child.exited
    expect(await waitFor(() => !standInAlive(profile), 5000)).toBe(true)
  })

  test("the same, when the script is killed hard", async () => {
    const { child, profile } = await run("hang+launcher")
    expect(standInAlive(profile)).toBe(true)
    child.kill("SIGKILL")
    await child.exited
    expect(await waitFor(() => !standInAlive(profile), 20_000)).toBe(true)
  })
})

describe.skipIf(!processes)("the sweep at the start of a run", () => {
  test("kills a browser whose owner is gone, and leaves one whose owner is alive", async () => {
    // A pid that is certainly gone: a process that ran and ended.
    const gone = Bun.spawn([process.execPath, "-e", "0"])
    await gone.exited
    mkdirSync(scratch, { recursive: true })
    const start = (ownerPid: number) => {
      const profile = join(scratch, `nikverse-browser-${ownerPid}`)
      mkdirSync(profile, { recursive: true })
      profiles.add(profile)
      const child = Bun.spawn([process.execPath, dummy, `--user-data-dir=${profile}`], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      })
      spawned.push(child.pid)
      return { pid: child.pid, profile }
    }
    const orphan = start(gone.pid)
    const kept = start(process.pid)
    expect(await waitFor(() => standInAlive(orphan.profile) && standInAlive(kept.profile), 15_000)).toBe(true)
    const killed = sweepOrphans([scratch], isAlive, () => browserProcesses("bun"))
    expect(killed).toContain(orphan.pid)
    expect(killed).not.toContain(kept.pid)
    expect(await waitFor(() => !isAlive(orphan.pid), 3000)).toBe(true)
    expect(isAlive(kept.pid)).toBe(true)
    // The orphan's profile folder goes with it; the live one's stays.
    expect(existsSync(orphan.profile)).toBe(false)
    expect(existsSync(kept.profile)).toBe(true)
    killTree(kept.pid)
  })
})

const edge = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].find(existsSync)

describe.skipIf(!processes || !edge || process.platform !== "win32")("the real headless Edge of the harness", () => {
  test("no msedge of the harness is left after a script that dies with it open, or is killed hard, or closes it", async () => {
    const script = join(scratch, "real-harness.ts")
    mkdirSync(scratch, { recursive: true })
    await Bun.write(
      script,
      `import { startHarness } from ${JSON.stringify(join(packageRoot, "scripts", "nikverse-harness.ts").replaceAll("\\", "/"))}
const harness = await startHarness({ out: ${JSON.stringify(scratch.replaceAll("\\", "/"))}, gpu: "software" })
console.log("open")
if (process.argv[2] === "close") harness.close()
if (process.argv[2] !== "hang") process.exit(process.argv[2] === "close" ? 0 : 1)
setInterval(() => {}, 1000)
`,
    )
    const ours = (ownerPid: number) => browserProcesses().filter((p) => ownerOf(p.commandLine) === ownerPid)
    const start = async (mode: string) => {
      const child = Bun.spawn([process.execPath, script, mode], { stdout: "pipe", stderr: "pipe", cwd: packageRoot })
      spawned.push(child.pid)
      const text = await saidLaunched(child, "open")
      if (!text.includes("open"))
        throw new Error(
          `the harness did not open: ${text} ${await new Response(child.stderr as ReadableStream).text()}`,
        )
      return child
    }
    // A script that closes its browser.
    const closing = await start("close")
    await closing.exited
    // Edge's helpers (its GPU process) take a moment to go after the browser: waited for, as in the two cases below, and never left.
    expect(await waitFor(() => ours(closing.pid).length === 0, HELPERS_GONE_MS)).toBe(true)
    // A script that exits without closing: the exit hook takes the whole browser.
    const first = await start("exit")
    await first.exited
    expect(await waitFor(() => ours(first.pid).length === 0, HELPERS_GONE_MS)).toBe(true)
    // A script killed hard: the watchdog takes it. The real browser is up and stays up for as long as its script lives.
    const second = await start("hang")
    expect(await waitFor(() => ours(second.pid).length > 0, HELPERS_GONE_MS)).toBe(true)
    // Up for as long as its script lives: seen up at every look for four seconds, not looked at once after a wait.
    expect(await staysTrue(() => ours(second.pid).length > 0, 4000)).toBe(true)
    second.kill("SIGKILL")
    await second.exited
    expect(await waitFor(() => ours(second.pid).length === 0, HELPERS_GONE_MS * 3)).toBe(true)
  }, 180_000)
})
