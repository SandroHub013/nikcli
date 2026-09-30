import { describe, expect, test } from "bun:test"
import type { InstalledPlugin } from "./activation"
import { PLUGIN_CHECK_EVERY_MS, checkForUpdates, shouldCheck, type Available, type UpdateIo } from "./updates"

const plugin = (id: string, over: Partial<InstalledPlugin> = {}): InstalledPlugin => ({ id, current: "1.0.0", bytes: 1, permissions: [], ...over })
const offer = (id: string, over: Partial<Available> = {}): Available => ({ id, version: "1.1.0", update: true, size_bytes: 10, permissions: [], ...over })

function rig(installed: InstalledPlugin[], offers: Record<string, Available | Error>, options: { rejected?: string[]; nothingToDownload?: boolean } = {}) {
  const log: string[] = []
  const io: UpdateIo = {
    list: async () => installed,
    check: async (id) => {
      log.push(`check ${id}`)
      const answer = offers[id]!
      if (answer instanceof Error) throw answer
      return answer
    },
    install: async (id) => {
      log.push(`install ${id}`)
      return !options.nothingToDownload
    },
    rejected: (id, version) => (options.rejected ?? []).includes(`${id}@${version}`),
  }
  return { io, log }
}

describe("the check for new versions", () => {
  test("a version on offer is downloaded in the background, and nothing else is done: it is switched on at the next opening", async () => {
    const { io, log } = rig([plugin("hello")], { hello: offer("hello") })
    expect(await checkForUpdates(io)).toEqual([{ id: "hello", version: "1.1.0", outcome: "downloaded" }])
    expect(log).toEqual(["check hello", "install hello"])
  })

  test("nothing to offer: nothing is downloaded", async () => {
    const { io, log } = rig([plugin("hello")], { hello: offer("hello", { update: false }) })
    expect((await checkForUpdates(io))[0]!.outcome).toBe("up-to-date")
    expect(log).toEqual(["check hello"])
  })

  test("a version that was taken back is not downloaded again", async () => {
    const { io, log } = rig([plugin("hello")], { hello: offer("hello") }, { rejected: ["hello@1.1.0"] })
    expect((await checkForUpdates(io))[0]!.outcome).toBe("rejected")
    expect(log).toEqual(["check hello"])
  })

  test("a plugin served from a folder is not on any index and is not asked about", async () => {
    const { io, log } = rig([plugin("dev", { dev: true })], {})
    expect(await checkForUpdates(io)).toEqual([])
    expect(log).toEqual([])
  })

  test("one that fails does not stop the others, and nothing throws", async () => {
    const { io } = rig([plugin("one"), plugin("two")], { one: new Error("nessuna chiave dei plugin in questa build"), two: offer("two") })
    const results = await checkForUpdates(io)
    expect(results.map((r) => [r.id, r.outcome])).toEqual([
      ["one", "failed"],
      ["two", "downloaded"],
    ])
    expect(results[0]!.reason).toContain("nessuna chiave")
  })

  test("a list that cannot be read is one failure, not a crash", async () => {
    const result = await checkForUpdates({
      list: async () => {
        throw new Error("no host")
      },
      check: async () => offer("x"),
      install: async () => true,
      rejected: () => false,
    })
    expect(result).toEqual([{ id: "*", outcome: "failed", reason: "no host" }])
  })

  test("nothing installed, nothing asked", async () => {
    const { io, log } = rig([], {})
    expect(await checkForUpdates(io)).toEqual([])
    expect(log).toEqual([])
  })

  test("a download that had nothing to fetch is not reported as one", async () => {
    const { io } = rig([plugin("hello")], { hello: offer("hello") }, { nothingToDownload: true })
    expect((await checkForUpdates(io))[0]!.outcome).toBe("up-to-date")
  })
})

describe("when the index is asked", () => {
  const HOUR = 60 * 60_000

  test("the first time, and after six hours", () => {
    expect(PLUGIN_CHECK_EVERY_MS).toBe(6 * HOUR)
    expect(shouldCheck(undefined, 1000)).toBe(true)
    expect(shouldCheck(0, 6 * HOUR - 1)).toBe(false)
    expect(shouldCheck(0, 6 * HOUR)).toBe(true)
  })

  test("a person pressing the command asks at once, and a clock that went back does not block", () => {
    expect(shouldCheck(1000, 1001, true)).toBe(true)
    expect(shouldCheck(5000, 1000)).toBe(true)
    expect(shouldCheck(Number.NaN, 1000)).toBe(true)
  })
})
