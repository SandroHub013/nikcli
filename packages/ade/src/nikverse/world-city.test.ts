import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { CITY_MODULE, PORT_OFFER, boot, readOptions } from "./world/world.js"

const NONCE = "0123456789abcdef".repeat(3)

const shop = (id: string) => ({ id, name: id, slot: 0 })
const agent = (paneId: string, over: Record<string, unknown> = {}) => ({
  paneId,
  title: paneId,
  kind: "claude-code",
  shop: "s1",
  state: "work",
  since: 1,
  look: { body: 0, palette: 0 },
  ...over,
})

/** A window with just enough of one for `boot`, the port ADE would hand over, and what the page sent on it. */
function page(search = "") {
  document.body.innerHTML =
    '<div id="stage"></div><main id="world"></main><span id="status"></span><p id="empty" hidden></p><section id="shops"></section>'
  delete document.documentElement.dataset.city
  delete document.documentElement.dataset.cityError
  const listeners = new Map<string, (event: unknown) => void>()
  const parent = { postMessage: () => {} }
  const win = {
    document,
    parent,
    location: { hash: `#n=${NONCE}`, search },
    requestAnimationFrame: (fn: () => void) => {
      queueMicrotask(fn)
      return 1
    },
    cancelAnimationFrame: () => {},
    addEventListener: (type: string, fn: (event: unknown) => void) => void listeners.set(type, fn),
    removeEventListener: (type: string) => void listeners.delete(type),
  }
  const seen: unknown[] = []
  const port = {
    onmessage: undefined as undefined | ((event: { data: unknown }) => void),
    postMessage: (message: unknown) => void seen.push(message),
  }
  const offer = () => listeners.get("message")?.({ source: parent, data: { type: PORT_OFFER, version: 1 }, ports: [port] })
  const fromAde = (data: unknown) => port.onmessage?.({ data })
  const key = (init: Record<string, unknown>) => listeners.get("keydown")?.({ preventDefault() {}, ...init })
  const hide = () => listeners.get("pagehide")?.({})
  return { win, offer, fromAde, key, hide, seen }
}

/** A city that records what the page asks of it. */
function fakeCity() {
  const calls: string[] = []
  const started: Array<Record<string, unknown>> = []
  const handle = {
    sync: () => void calls.push("sync"),
    pause: () => void calls.push("pause"),
    resume: () => void calls.push("resume"),
    dispose: () => void calls.push("dispose"),
  }
  const module = {
    startCity: (deps: Record<string, unknown>) => {
      started.push(deps)
      return Promise.resolve(handle)
    },
  }
  return { module, started, calls }
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("the 3D city the page starts", () => {
  test("the module it loads is the bundle the scheme serves from the assets folder, by address", () => {
    expect(CITY_MODULE).toBe("./assets/world/city.js")
    const source = readFileSync(join(import.meta.dir, "world", "world.js"), "utf8")
    expect(source).toContain(`import("${CITY_MODULE}")`)
    // The only dynamic import, and no static one: the world's own code stays this one small file.
    expect(source.match(/\bimport\(/g)).toHaveLength(1)
    expect(source).not.toMatch(/^import /m)
  })

  test("the query options are ?check=logo and ?renderer=classic, and nothing else: WebGPURenderer's WebGL backend cannot be asked for", () => {
    expect(readOptions("")).toEqual({ check: false, classic: false, quality: undefined, shot: undefined, bench: false, tune: undefined })
    expect(readOptions("?check=logo")).toEqual({ check: true, classic: false, quality: undefined, shot: undefined, bench: false, tune: undefined })
    expect(readOptions("?renderer=classic&check=logo")).toEqual({ check: true, classic: true, quality: undefined, shot: undefined, bench: false, tune: undefined })
    expect(readOptions("?quality=alta").quality).toBe("alta")
    expect(readOptions("?x=1").quality).toBeUndefined()
    // For measuring, `?samples=1|4` and `?maxscale=0.75..1`, and only through the bench's door: a page without it ignores them.
    expect(readOptions("?bench=1&samples=1&maxscale=0.9").tune).toEqual({ samples: 1, maxScale: 0.9 })
    expect(readOptions("?bench=1&compile=async").tune).toEqual({ compile: "async" })
    expect(readOptions("?compile=async").tune).toBeUndefined()
    expect(JSON.parse(JSON.stringify(readOptions("?shot=3&samples=4").tune))).toEqual({ samples: 4 })
    expect(readOptions("?samples=1&maxscale=0.9").tune).toBeUndefined()
    // WebGPU has no 2x, and a scale outside the governor's range is nothing.
    expect(readOptions("?bench=1&samples=2&maxscale=0.5").tune).toBeUndefined()
    expect(readOptions("?bench=1&maxscale=1.5").tune).toBeUndefined()
    // ?shot=1..8 is the bench; anything else is no shot.
    expect(readOptions("?shot=4&quality=media")).toEqual({ check: false, classic: false, quality: "media", shot: 4, bench: false, tune: undefined })
    expect(readOptions("?bench=1").bench).toBe(true)
    expect(readOptions("?bench=true").bench).toBe(false)
    for (const bad of ["?shot=0", "?shot=9", "?shot=2.5", "?shot=x", "?shot="]) expect(readOptions(bad).shot).toBeUndefined()
    for (const other of ["?check=other&renderer=webgpu", "?renderer=webgl", "?forceWebGL=1"])
      expect(readOptions(other)).toEqual({ check: false, classic: false, quality: undefined, shot: undefined, bench: false, tune: undefined })
    const source = readFileSync(join(import.meta.dir, "world", "world.js"), "utf8")
    expect(source).not.toMatch(/forceWebGL/)
  })

  test("it starts the city with the picture, a way to send commands, and the mode", async () => {
    const { win, offer, fromAde, seen } = page()
    const city = fakeCity()
    boot(win, { loadCity: async () => city.module })
    await settled()
    expect(document.documentElement.dataset.city).toBe("1")
    expect(city.started).toHaveLength(1)
    const deps = city.started[0] as {
      mode: string
      classic: boolean
      win: unknown
      send(command: unknown): void
      picture(): { shops: Map<string, unknown> }
    }
    expect([deps.mode, deps.classic, deps.win]).toEqual(["city", false, win])
    offer()
    fromAde({ type: "snapshot", snapshot: { at: 1, shops: [shop("s1")], agents: [agent("p1")], waiting: { decisions: 0 } } })
    // The picture it holds is the world's, as it is now.
    expect([...deps.picture().shops.keys()]).toEqual(["s1"])
    deps.send({ cmd: "open-session", paneId: "p1" })
    expect(seen).toContainEqual({ type: "command", command: { cmd: "open-session", paneId: "p1" } })
  })

  test("?check=logo starts it in its check mode (and marks the page so nothing but the logo shows), ?renderer=classic asks for the classic renderer", async () => {
    const one = fakeCity()
    boot(page("?check=logo").win, { loadCity: async () => one.module })
    expect(document.documentElement.dataset.check).toBe("1")
    await settled()
    expect(one.started[0]).toMatchObject({ mode: "logo-check", classic: false })
    delete document.documentElement.dataset.check
    const two = fakeCity()
    boot(page("?renderer=classic").win, { loadCity: async () => two.module })
    expect(document.documentElement.dataset.check).toBeUndefined()
    await settled()
    expect(two.started[0]).toMatchObject({ mode: "city", classic: true })
  })

  test("?shot=N hands the bench's shot to the city, and no shot when the number is not one", async () => {
    const one = fakeCity()
    boot(page("?shot=3&quality=media").win, { loadCity: async () => one.module })
    await settled()
    expect(one.started[0]).toMatchObject({ mode: "city", shot: 3, quality: "media" })
    const two = fakeCity()
    boot(page("?shot=12").win, { loadCity: async () => two.module })
    await settled()
    expect((two.started[0] as { shot?: number }).shot).toBeUndefined()
  })

  test("the GPU timing of the world's own drawing is on the window for the gate: it asks the city, and says so when there is none", async () => {
    const { win } = page("?bench=1")
    const timing = { frames: 2, mean: 1, p50: 1, p95: 2, max: 2, sync: "queue", timestampQuery: false }
    const asked: unknown[] = []
    const handle = { sync() {}, pause() {}, resume() {}, dispose() {}, bench: async (frames?: number) => (asked.push(frames), timing) }
    boot(win, { loadCity: async () => ({ startCity: async () => handle }) })
    await settled()
    const bench = (win as unknown as { __nikverseBench(frames?: number): Promise<unknown> }).__nikverseBench
    expect(await bench(120)).toEqual(timing)
    expect(asked).toEqual([120])
    // A city without a bench (the logo check's) refuses, it does not answer with nothing.
    const bare = page("?bench=1")
    boot(bare.win, { loadCity: async () => ({ startCity: async () => ({ sync() {}, pause() {}, resume() {}, dispose() {} }) }) })
    await settled()
    await expect((bare.win as unknown as { __nikverseBench(): Promise<unknown> }).__nikverseBench()).rejects.toThrow("no bench")
  })

  test("a release build has no timing door on the window: it is there only for ?bench=1 (ADE's test build) and ?shot (the bench)", async () => {
    const handle = { sync() {}, pause() {}, resume() {}, dispose() {}, bench: async () => ({}) }
    for (const [search, door] of [
      ["", false],
      ["?quality=alta", false],
      ["?bench=0", false],
      ["?bench=1", true],
      ["?shot=4&quality=media", true],
    ] as const) {
      const { win } = page(search)
      boot(win, { loadCity: async () => ({ startCity: async () => handle }) })
      await settled()
      expect([search, "__nikverseBench" in win]).toEqual([search, door])
    }
  })

  test("ADE keeps where the character stands: the world sends its position, and takes it back when it is up again", async () => {
    const { win, offer, fromAde, seen } = page()
    const city = fakeCity()
    const restored: unknown[] = []
    ;(city.module as { startCity: unknown }).startCity = (deps: Record<string, unknown>) => {
      city.started.push(deps)
      return Promise.resolve({
        sync() {},
        pause() {},
        resume() {},
        restore: (spot: unknown) => void restored.push(spot),
      })
    }
    boot(win, { loadCity: async () => city.module })
    offer()
    // ADE answers `ready` with the place before the city is up: it is held, and given once it starts.
    fromAde({ type: "player", x: 3, z: -4, heading: 1.5 })
    expect(restored).toEqual([])
    await settled()
    expect(restored).toEqual([{ x: 3, z: -4, heading: 1.5 }])
    // Once it is up, a later one goes straight to it.
    fromAde({ type: "player", x: 5, z: 6, heading: 0 })
    expect(restored.at(-1)).toEqual({ x: 5, z: 6, heading: 0 })
    // And the world tells ADE where the character is: the whole spot, in a `position` message.
    const deps = city.started[0] as { savePosition(spot: { x: number; z: number; heading: number }): void }
    deps.savePosition({ x: 1.5, z: -2.5, heading: 0.5 })
    expect(seen).toContainEqual({ type: "position", x: 1.5, z: -2.5, heading: 0.5 })
  })

  test("what ADE sends reaches the city: every snapshot and event, and pause and resume", async () => {
    const { win, offer, fromAde } = page()
    const city = fakeCity()
    boot(win, { loadCity: async () => city.module })
    await settled()
    offer()
    fromAde({ type: "snapshot", snapshot: { at: 1, shops: [shop("s1")], agents: [], waiting: { decisions: 0 } } })
    fromAde({ type: "event", event: { type: "shop-open", shop: shop("s2") } })
    fromAde({ type: "event", event: { type: "agent-spawn", agent: agent("p", { shop: "s2" }) } })
    expect(city.calls.filter((c) => c === "sync")).toHaveLength(3)
    fromAde({ type: "pause" })
    fromAde({ type: "resume" })
    // Resuming also hands over the picture as it is now.
    expect(city.calls.slice(-3)).toEqual(["pause", "resume", "sync"])
  })

  test("a pause that came before the city was up holds it paused from the start", async () => {
    const { win, offer, fromAde } = page()
    const city = fakeCity()
    let up!: () => void
    boot(win, { loadCity: () => new Promise((resolve) => (up = () => resolve(city.module))) })
    await settled()
    offer()
    fromAde({ type: "pause" })
    up()
    await settled()
    expect(city.calls[0]).toBe("pause")
  })

  test("Esc gives the focus back to ADE: there is no captured mouse to let go of first", async () => {
    const { win, offer, key, seen } = page()
    const city = fakeCity()
    boot(win, { loadCity: async () => city.module })
    await settled()
    offer()
    key({ key: "Escape" })
    expect(seen).toContainEqual({ type: "command", command: { cmd: "release-focus" } })
    expect(city.calls).not.toContain("release")
  })

  test("the frame going away disposes the city, once: the GPU's memory goes back now and not when the process is collected", async () => {
    const { win, offer, hide } = page()
    const city = fakeCity()
    boot(win, { loadCity: async () => city.module })
    await settled()
    offer()
    hide()
    hide()
    expect(city.calls.filter((call) => call === "dispose")).toHaveLength(1)
  })

  test("without the city (not built, or the renderer cannot start) the page works as the list, and says why", async () => {
    const { win, offer, fromAde } = page()
    boot(win, { loadCity: async () => Promise.reject(new Error("no such module")) })
    await settled()
    expect(document.documentElement.dataset.city).toBe("failed")
    expect(document.documentElement.dataset.cityError).toBe("no such module")
    offer()
    fromAde({ type: "snapshot", snapshot: { at: 1, shops: [shop("s1")], agents: [agent("p1")], waiting: { decisions: 0 } } })
    await settled()
    // The list is still drawn, from the same picture.
    expect(document.querySelectorAll("li.agent")).toHaveLength(1)
  })

  test("the module missing altogether is the same: a failed city, not a broken page", async () => {
    const { win } = page()
    const missing = "./world/no-such-city.js"
    boot(win, { loadCity: () => import(missing) })
    await settled()
    expect(document.documentElement.dataset.city).toBe("failed")
  })

  test("until the city's own phases, the opening says it is loading the city's module", async () => {
    const { win } = page()
    document.documentElement.removeAttribute("data-load")
    boot(win, { loadCity: () => new Promise(() => {}) })
    await settled()
    expect(document.documentElement.dataset.load).toBe("module")
  })
})

describe("what keeps the loop awake (old PCs, point 4)", () => {
  test("the bench's door asks the city, on demand; a release build has no such door", async () => {
    const awake = { mode: "still", animating: true }
    const handle = { sync() {}, pause() {}, resume() {}, dispose() {}, why: () => awake }
    const bench = page("?bench=1")
    boot(bench.win, { loadCity: async () => ({ startCity: async () => handle }) })
    await settled()
    expect((bench.win as unknown as { __nikverseWhy(): unknown }).__nikverseWhy()).toEqual(awake)
    const release = page()
    boot(release.win, { loadCity: async () => ({ startCity: async () => handle }) })
    await settled()
    expect((release.win as unknown as { __nikverseWhy?: unknown }).__nikverseWhy).toBeUndefined()
  })
})

describe("the world tells ADE it is on screen (old PCs, points 2 and 3)", () => {
  const opened = (seen: unknown[]) => seen.filter((m) => (m as { type?: string }).type === "opened").length

  test("once the city drew its first frame, not before, and only once", async () => {
    const { win, offer, seen } = page()
    const city = fakeCity()
    boot(win, { loadCity: async () => city.module })
    await settled()
    offer()
    expect(opened(seen)).toBe(0)
    const deps = city.started[0] as { onDrawn(): void }
    deps.onDrawn()
    deps.onDrawn()
    expect(opened(seen)).toBe(1)
  })

  test("drawn before ADE's port came, it says so as soon as the port is there", async () => {
    const { win, offer, seen } = page()
    const city = fakeCity()
    boot(win, { loadCity: async () => city.module })
    await settled()
    ;(city.started[0] as { onDrawn(): void }).onDrawn()
    expect(opened(seen)).toBe(0)
    offer()
    expect(opened(seen)).toBe(1)
  })

  test("a city that fails leaves the list, which is on screen too; ?city=0 is the list with no city at all", async () => {
    const failing = page()
    boot(failing.win, { loadCity: async () => Promise.reject(new Error("no renderer")) })
    await settled()
    failing.offer()
    expect(opened(failing.seen)).toBe(1)
    const list = page("?city=0")
    const city = fakeCity()
    boot(list.win, { loadCity: async () => city.module })
    await settled()
    list.offer()
    expect(city.started).toHaveLength(0)
    expect(document.documentElement.dataset.city).toBe("off")
    expect(opened(list.seen)).toBe(1)
  })

  test("a city too slow at its level tells ADE; one opened lowered by ADE knows it", async () => {
    const { win, offer, seen } = page("?quality=bassa&lowered=1")
    const city = fakeCity()
    boot(win, { loadCity: async () => city.module })
    await settled()
    offer()
    const deps = city.started[0] as { onSlow(): void; lowered?: boolean; quality?: string }
    expect([deps.quality, deps.lowered]).toEqual(["bassa", true])
    deps.onSlow()
    expect(seen).toContainEqual({ type: "slow" })
    expect(readOptions("").lowered).toBeUndefined()
  })
})
