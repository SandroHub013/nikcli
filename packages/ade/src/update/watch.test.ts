import { describe, expect, test } from "bun:test"
import {
  CHECK_EVERY_MS,
  MAX_CALLS_PER_HOUR,
  MIN_CHECK_GAP_MS,
  checkMessage,
  createUpdateWatch,
  githubReleaseFeed,
  type CheckResult,
  type ReleaseFeed,
} from "./watch"

const RELEASES = [
  {
    tag_name: "ade-v1.1.0",
    html_url: "https://github.com/SandroHub013/nikcli/releases/tag/ade-v1.1.0",
    draft: false,
    prerelease: false,
  },
]

/** A feed whose answers the test decides, counting what was asked of it. */
function feed(answers: (() => Promise<{ releases?: typeof RELEASES; notModified: boolean }>)[] = []) {
  let calls = 0
  const service: ReleaseFeed = {
    read: async () => {
      const answer = answers[calls] ?? (async () => ({ releases: RELEASES, notModified: false }))
      calls++
      return answer()
    },
  }
  return { service, calls: () => calls }
}

/** A watch over a clock the test moves by hand. */
function watching(options: { visible?: boolean; version?: string; answers?: Parameters<typeof feed>[0] } = {}) {
  let clock = 1_000_000
  const releases = feed(options.answers)
  const announced: string[] = []
  let visible = options.visible ?? true
  const watch = createUpdateWatch({
    currentVersion: async () => options.version ?? "1.0.0",
    onUpdate: (update) => announced.push(update.version),
    feed: releases.service,
    isVisible: () => visible,
    now: () => clock,
  })
  return {
    watch,
    announced,
    calls: releases.calls,
    advance: (ms: number) => {
      clock += ms
    },
    hide: () => {
      visible = false
    },
    show: () => {
      visible = true
    },
  }
}

describe("createUpdateWatch", () => {
  test("checks often enough to notice a release while the window is open", () => {
    expect(CHECK_EVERY_MS).toBeGreaterThanOrEqual(2 * 60_000)
    expect(CHECK_EVERY_MS).toBeLessThanOrEqual(5 * 60_000)
  })

  test("a new version is announced once, and later checks still report it", async () => {
    const it = watching()
    expect((await it.watch.check()).update?.version).toBe("1.1.0")
    it.advance(MIN_CHECK_GAP_MS)
    const again = await it.watch.check()
    expect(again.status).toBe("update")
    expect(it.announced).toEqual(["1.1.0"])
  })

  test("a build on the newest release is told so, with its own version", async () => {
    const it = watching({ version: "1.1.0" })
    const result = await it.watch.check()
    expect(result.status).toBe("current")
    expect(result.currentVersion).toBe("1.1.0")
    expect(checkMessage(result).text).toBe("Nessun aggiornamento: ADE 1.1.0 è l'ultima versione.")
  })

  test("a hidden window is not checked, and the check runs once it is back", async () => {
    const it = watching()
    it.hide()
    const skipped = await it.watch.check()
    expect(skipped.status).toBe("skipped")
    expect(it.calls()).toBe(0)

    it.show()
    expect((await it.watch.check()).status).toBe("update")
    expect(it.calls()).toBe(1)
  })

  test("two checks in a row are one call, unless a person asked", async () => {
    const it = watching()
    await it.watch.check()
    it.advance(MIN_CHECK_GAP_MS - 1)

    const tooSoon = await it.watch.check()
    expect(tooSoon.status).toBe("skipped")
    expect(it.calls()).toBe(1)

    // "Controlla aggiornamenti" does not wait for the timer.
    expect((await it.watch.check({ force: true })).status).toBe("update")
    expect(it.calls()).toBe(2)
  })

  test("a forced check works even with the window hidden", async () => {
    const it = watching()
    it.hide()
    expect((await it.watch.check({ force: true })).status).toBe("update")
    expect(it.calls()).toBe(1)
  })

  test("an unchanged list costs nothing, so the hourly budget is untouched", async () => {
    const answers = Array.from({ length: MAX_CALLS_PER_HOUR + 5 }, () => async () => ({ notModified: true }))
    const it = watching({ answers })
    for (let i = 0; i < MAX_CALLS_PER_HOUR + 5; i++) {
      const result = await it.watch.check({ force: true })
      expect(result.status).toBe("unchanged")
    }
    expect(it.calls()).toBe(MAX_CALLS_PER_HOUR + 5)
  })

  test("the hourly budget stops the charged calls, and comes back an hour later", async () => {
    const it = watching()
    for (let i = 0; i < MAX_CALLS_PER_HOUR; i++) await it.watch.check({ force: true })
    expect(it.calls()).toBe(MAX_CALLS_PER_HOUR)

    const stopped = await it.watch.check({ force: true })
    expect(stopped.status).toBe("skipped")
    expect(stopped.problem).toContain("Troppi controlli")
    expect(it.calls()).toBe(MAX_CALLS_PER_HOUR)

    it.advance(60 * 60_000)
    expect((await it.watch.check({ force: true })).status).toBe("update")
    expect(it.calls()).toBe(MAX_CALLS_PER_HOUR + 1)
  })

  test("a failed request is reported, said plainly, and counted", async () => {
    const it = watching({ answers: [async () => Promise.reject(new Error("GitHub 503"))] })
    const result = await it.watch.check()
    expect(result.status).toBe("error")
    expect(checkMessage(result).kind).toBe("error")
    expect(checkMessage(result).text).toContain("GitHub 503")
  })

  test("the window coming back to the front asks for a check", async () => {
    let wake: (() => void) | undefined
    let released = false
    const releases = feed()
    const watch = createUpdateWatch({
      currentVersion: async () => "1.0.0",
      onUpdate: () => {},
      feed: releases.service,
      now: () => 1_000_000,
      onForeground: (run) => {
        wake = run
        return () => {
          released = true
        }
      },
    })
    watch.start()
    expect(typeof wake).toBe("function")
    wake?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(releases.calls()).toBe(1)
    watch.stop()
    expect(released).toBe(true)
  })
})

describe("githubReleaseFeed", () => {
  test("asks with the tag it was given, and reads a 304 as unchanged", async () => {
    const seen: (HeadersInit | undefined)[] = []
    let call = 0
    const doFetch = (async (_url: string, init?: RequestInit) => {
      seen.push(init?.headers)
      call++
      if (call === 1) {
        return new Response(JSON.stringify(RELEASES), { status: 200, headers: { etag: 'W/"abc"' } })
      }
      return new Response(null, { status: 304 })
    }) as unknown as typeof fetch

    const it = githubReleaseFeed(doFetch)
    const first = await it.read()
    expect(first.releases?.length).toBe(1)
    expect((seen[0] as Record<string, string>)["If-None-Match"]).toBeUndefined()

    const second = await it.read()
    expect(second.notModified).toBe(true)
    expect(second.releases).toBeUndefined()
    expect((seen[1] as Record<string, string>)["If-None-Match"]).toBe('W/"abc"')
  })

  test("a failed request says which status it was", async () => {
    const doFetch = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch
    expect(githubReleaseFeed(doFetch).read()).rejects.toThrow("GitHub 403")
  })
})

describe("checkMessage", () => {
  test("says something whatever happened", () => {
    const at = 0
    const cases: CheckResult[] = [
      { status: "update", at, update: { version: "1.2.0", url: "https://github.com/SandroHub013/nikcli/releases/tag/ade-v1.2.0" } },
      { status: "current", at, currentVersion: "1.2.0" },
      { status: "unchanged", at, currentVersion: "1.2.0" },
      { status: "skipped", at, problem: "Controllato da poco." },
      { status: "error", at, problem: "offline" },
    ]
    for (const result of cases) expect(checkMessage(result).text.length).toBeGreaterThan(0)
    expect(checkMessage(cases[0]!).href).toContain("/releases/tag/ade-v1.2.0")
  })
})
