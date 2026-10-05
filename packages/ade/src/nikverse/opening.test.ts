import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { LOWERED_FOR_MS, LOWERED_KEY, OPEN_TIMEOUT_MS, createLoweredStore, createOpenWatch, worldQuery } from "./opening"

function clock() {
  const timers: { at: number; run: () => void; live: boolean }[] = []
  let now = 0
  return {
    schedule: (run: () => void, ms: number) => {
      const timer = { at: now + ms, run, live: true }
      timers.push(timer)
      return () => void (timer.live = false)
    },
    advance(ms: number) {
      const end = now + ms
      for (;;) {
        const next = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!next) break
        now = next.at
        next.live = false
        next.run()
      }
      now = end
    },
  }
}

describe("waiting for the world to open", () => {
  test("not on screen in 30 seconds: the panel says so, once", () => {
    const c = clock()
    let late = 0
    const watch = createOpenWatch({ schedule: c.schedule, visible: () => true, late: () => late++ })
    watch.start()
    c.advance(OPEN_TIMEOUT_MS - 1)
    expect(late).toBe(0)
    c.advance(1)
    expect(late).toBe(1)
    c.advance(OPEN_TIMEOUT_MS * 3)
    expect(late).toBe(1)
  })

  test("opened in time, nothing is said; a reload starts the wait again", () => {
    const c = clock()
    let late = 0
    const watch = createOpenWatch({ schedule: c.schedule, visible: () => true, late: () => late++ })
    watch.start()
    c.advance(20_000)
    watch.opened()
    c.advance(OPEN_TIMEOUT_MS)
    expect(late).toBe(0)
    watch.start()
    c.advance(OPEN_TIMEOUT_MS)
    expect(late).toBe(1)
  })

  test("hidden for most of the wait and then seen: the 30 seconds start again from when it is seen", () => {
    const c = clock()
    let late = 0
    const watch = createOpenWatch({ schedule: c.schedule, visible: () => true, late: () => late++ })
    watch.start()
    c.advance(28_000)
    watch.seenAgain()
    c.advance(OPEN_TIMEOUT_MS - 1)
    expect(late).toBe(0)
    c.advance(1)
    expect(late).toBe(1)
    // Once opened, being seen again starts nothing.
    watch.start()
    watch.opened()
    watch.seenAgain()
    c.advance(OPEN_TIMEOUT_MS * 2)
    expect(late).toBe(1)
  })

  test("a hidden panel holds the world's frames: that time is waited again, it is not a failed opening", () => {
    const c = clock()
    let late = 0
    let seen = false
    const watch = createOpenWatch({ schedule: c.schedule, visible: () => seen, late: () => late++ })
    watch.start()
    c.advance(OPEN_TIMEOUT_MS * 2)
    expect(late).toBe(0)
    seen = true
    c.advance(OPEN_TIMEOUT_MS)
    expect(late).toBe(1)
  })
})

describe("the level ADE lowered the world to", () => {
  const memory = () => {
    const data = new Map<string, string>()
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data }
  }

  test("too slow once: Bassa for a week, kept in storage, then the machine's own level again", () => {
    let now = 1_000_000
    const storage = memory()
    const store = createLoweredStore(storage, () => now)
    expect(store.lowered()).toBe(false)
    store.lower()
    expect(JSON.parse(storage.data.get(LOWERED_KEY)!)).toEqual({ at: 1_000_000 })
    expect(createLoweredStore(storage, () => now).lowered()).toBe(true)
    now += LOWERED_FOR_MS
    expect(createLoweredStore(storage, () => now).lowered()).toBe(false)
  })

  test("storage that throws or holds something else is not lowered, and lowering still holds for the session", () => {
    const fail = () => {
      throw new Error("no storage")
    }
    const store = createLoweredStore({ getItem: fail, setItem: fail })
    expect(store.lowered()).toBe(false)
    store.lower()
    expect(store.lowered()).toBe(true)
    const junk = memory()
    junk.setItem(LOWERED_KEY, "{oops")
    expect(createLoweredStore(junk).lowered()).toBe(false)
  })
})

describe("the line of an opening that did not come", () => {
  test("has its own rule: a row with padding, the text taking the room, and ADE's buttons", () => {
    const css = readFileSync(join(import.meta.dir, "nikverse.css"), "utf8")
    const rule = (selector: string) => css.match(new RegExp(`(^|\\n)${selector.replace(/[[\]"=]/g, "\\$&")} \\{([^}]*)\\}`))?.[2] ?? ""
    const box = rule('[data-slot="nikverse-late"]')
    for (const line of ["display: flex", "align-items: center", "padding: 8px 12px", "position: absolute"]) expect(box).toContain(line)
    expect(rule('[data-slot="nikverse-late"] p')).toContain("margin: 0")
    expect(rule('[data-slot="nikverse-late"] button')).toContain("border-radius: var(--ade-radius-sm)")
  })
})

describe("a reload of the world", () => {
  test("is a new frame element: a retry's address differs only after the #, which reloads nothing", () => {
    // «Riprova» and the files coming late change only the nonce, after the `#`: the same element would keep the old
    // document, whose port reloadFrame has just closed, and the opening would be late again 30 s later.
    expect(new URL("https://nikverse.localhost/?bench=1#n=a").search).toBe(new URL("https://nikverse.localhost/?bench=1#n=b").search)
    const pane = readFileSync(join(import.meta.dir, "nikverse-pane.tsx"), "utf8")
    const reload = pane.slice(pane.indexOf("const reloadFrame = () => {"), pane.indexOf("/** Whether the panel can be seen"))
    expect(reload).toContain("setFrameLoad((n) => n + 1)")
    expect(pane).toMatch(/<Show when=\{frameLoad\(\)\} keyed>\s*\{\(_load\) => \(\s*<iframe/)
  })
})

describe("the world's address", () => {
  test("the bench door, the lowered level and the list go in the query; nothing, no query", () => {
    expect(worldQuery({})).toBe("")
    expect(worldQuery({ bench: "bench=1&maxscale=0.9" })).toBe("?bench=1&maxscale=0.9")
    expect(worldQuery({ lowered: true })).toBe("?quality=bassa&lowered=1")
    expect(worldQuery({ bench: "bench=1", lowered: true, list: true })).toBe("?quality=bassa&lowered=1&bench=1&city=0")
    // A trial that also names a quality: the page reads the first one, which is the lowered level.
    expect(new URLSearchParams(worldQuery({ bench: "bench=1&quality=auto&slowwatch=1", lowered: true }).slice(1)).get("quality")).toBe("bassa")
  })
})
