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
  return { win, offer, fromAde, key, seen }
}

/** A city that records what the page asks of it. */
function fakeCity() {
  const calls: string[] = []
  const started: Array<Record<string, unknown>> = []
  let captured = false
  const handle = {
    sync: () => void calls.push("sync"),
    pause: () => void calls.push("pause"),
    resume: () => void calls.push("resume"),
    captured: () => captured,
    releaseCapture: () => {
      calls.push("release")
      captured = false
    },
  }
  const module = {
    startCity: (deps: Record<string, unknown>) => {
      started.push(deps)
      return Promise.resolve(handle)
    },
  }
  return { module, started, calls, capture: () => (captured = true) }
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
    expect(readOptions("")).toEqual({ check: false, classic: false })
    expect(readOptions("?check=logo")).toEqual({ check: true, classic: false })
    expect(readOptions("?renderer=classic&check=logo")).toEqual({ check: true, classic: true })
    for (const other of ["?check=other&renderer=webgpu", "?renderer=webgl", "?forceWebGL=1"])
      expect(readOptions(other)).toEqual({ check: false, classic: false })
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
        captured: () => false,
        releaseCapture() {},
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

  test("Esc lets go of a captured mouse first, then gives the focus back to ADE", async () => {
    const { win, offer, key, seen } = page()
    const city = fakeCity()
    boot(win, { loadCity: async () => city.module })
    await settled()
    offer()
    city.capture()
    key({ key: "Escape" })
    expect(city.calls).toContain("release")
    expect(seen.filter((m) => (m as { type: string }).type === "command")).toEqual([])
    key({ key: "Escape" })
    expect(seen).toContainEqual({ type: "command", command: { cmd: "release-focus" } })
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
})
