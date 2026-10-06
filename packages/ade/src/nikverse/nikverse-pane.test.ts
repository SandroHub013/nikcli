import { afterEach, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { compileSolidJsx } from "../test-support/solid-jsx"
import { OPEN_TIMEOUT_MS } from "./opening"
import { UNLOAD_AFTER_MS } from "./lifecycle"
import { HELLO } from "./handshake"

/*
 * A reload of the world is a new frame element. «Riprova» changes only the nonce, after the `#`, and a frame whose
 * address changes only there keeps its document: the old one stayed, without the port the reload had just closed,
 * and 30 s later the panel said again that the world had not opened (live test, 2026-10-05).
 */

if (typeof document === "undefined") GlobalRegistrator.register()
compileSolidJsx()

// happy-dom would try to fetch the world's `nikverse://` address: the frame element is what is looked at, not its page.
const navigation = (window as unknown as { happyDOM?: { settings: { navigation: { disableChildFrameNavigation: boolean } } } }).happyDOM?.settings.navigation

const { createComponent, render } = await import("solid-js/web")
const { NikversePane } = await import("./nikverse-pane")

let dispose: (() => void) | undefined
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const childFrames = navigation?.disableChildFrameNavigation
const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState")
afterEach(() => {
  dispose?.()
  dispose = undefined
  if (navigation && childFrames !== undefined) navigation.disableChildFrameNavigation = childFrames
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
  if (visibility) Object.defineProperty(document, "visibilityState", visibility)
  else delete (document as unknown as { visibilityState?: string }).visibilityState
  document.body.innerHTML = ""
})

/** The 30 s of the opening, held here so the test can let them pass; every other timer runs as it is. */
function holdOpenings() {
  const held = new Map<number, () => void>()
  let next = 1_000_000_000
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms !== OPEN_TIMEOUT_MS) return realSetTimeout(fn, ms, ...rest)
    held.set(++next, fn)
    return next
  }) as typeof setTimeout
  globalThis.clearTimeout = ((id?: number) => {
    if (id !== undefined && held.delete(id)) return
    realClearTimeout(id)
  }) as typeof clearTimeout
  return () => {
    const due = [...held.values()]
    held.clear()
    for (const fn of due) fn()
  }
}

/*
 * Review of F7d, B4. First in this file on purpose: the panel's store of the lowering reads its storage once, the first time
 * a pane is built, so a test that needs it lowered has to set the storage before any pane of the run exists.
 */
test("a world lowered to Bassa offers «Riprova a qualità piena», which forgets it and reloads at the machine's level", () => {
  localStorage.setItem("ade.nikverse.lowered", JSON.stringify({ at: Date.now() }))
  if (navigation) navigation.disableChildFrameNavigation = true
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () =>
      createComponent(NikversePane, {
        picture: () => undefined,
        focused: false,
        onOpenSession: () => {},
        onFocusProject: () => {},
        onChord: () => {},
      }),
    host,
  )
  const frame = () => host.querySelector<HTMLIFrameElement>('iframe[data-slot="nikverse-frame"]')!
  expect(new URL(frame().src).searchParams.get("quality")).toBe("bassa")
  const retry = host.querySelector<HTMLButtonElement>('[data-slot="nikverse-lowered-retry"]')
  expect(retry?.textContent).toBe("Riprova a qualità piena")
  retry!.click()
  expect(new URL(frame().src).searchParams.get("quality")).toBeNull()
  expect(host.querySelector('[data-slot="nikverse-lowered-retry"]')).toBeNull()
  expect(JSON.parse(localStorage.getItem("ade.nikverse.lowered") ?? "null")).toBeNull()
})

test("«Riprova» and «Apri la lista» each load the world in a new frame element, not the old one with a new #", () => {
  const thirtySecondsPass = holdOpenings()
  if (navigation) navigation.disableChildFrameNavigation = true
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () =>
      createComponent(NikversePane, {
        picture: () => undefined,
        focused: false,
        onOpenSession: () => {},
        onFocusProject: () => {},
        onChord: () => {},
      }),
    host,
  )
  const frame = () => host.querySelector<HTMLIFrameElement>('iframe[data-slot="nikverse-frame"]')!
  const late = () => host.querySelector('[data-slot="nikverse-late"]')
  const first = frame()
  expect(first).toBeTruthy()
  expect(late()).toBeNull()

  thirtySecondsPass()
  expect(late()).not.toBeNull()
  host.querySelector<HTMLButtonElement>('[data-slot="nikverse-late-retry"]')!.click()
  const second = frame()
  expect(second).not.toBe(first)
  expect(first.isConnected).toBe(false)
  // The same address but for the nonce: exactly what the same element would not have reloaded.
  expect(new URL(second.src).search).toBe(new URL(first.src).search)
  expect(second.src).not.toBe(first.src)
  expect(late()).toBeNull()

  thirtySecondsPass()
  host.querySelector<HTMLButtonElement>('[data-slot="nikverse-late-list"]')!.click()
  const third = frame()
  expect(third).not.toBe(second)
  expect(new URL(third.src).searchParams.get("city")).toBe("0")
  expect(host.querySelectorAll("iframe")).toHaveLength(1)
})

/*
 * The lessons over the world: `open-learn` puts a layer in ADE's DOM above the world's frame, in the same panel. Two frames then
 * talk to ADE at once, each with its own nonce and its own port, and the world is paused for as long as the layer is open.
 * In this file, after the first test, because the pane's store of the lowering reads its storage once per process.
 */
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
  await new Promise((resolve) => realSetTimeout(resolve, 5))
}

/** What ADE sent to a frame's window through `postMessage`: the offers of a port, which is how a frame is told it was believed. */
function watch(frame: HTMLIFrameElement) {
  const offers: MessagePort[] = []
  const win = frame.contentWindow as unknown as { postMessage: unknown }
  Object.defineProperty(win, "postMessage", {
    configurable: true,
    value: (_message: unknown, _origin: string, ports?: MessagePort[]) => void (ports ?? []).forEach((port) => offers.push(port)),
  })
  return { window: frame.contentWindow as Window, offers }
}

const nonceOf = (frame: HTMLIFrameElement) => new URLSearchParams(new URL(frame.src).hash.slice(1)).get("n")!

/** The frame says `hello` the way a page does: a message on ADE's window whose source is the frame's window. */
function hello(from: Window, nonce: string) {
  window.dispatchEvent(new MessageEvent("message", { source: from as unknown as MessageEventSource, data: { type: HELLO, nonce } }))
}

/** What came through a port ADE gave a frame, in order. */
function listen(port: MessagePort) {
  const got: { type: string }[] = []
  port.onmessage = (event) => void got.push(event.data)
  return got
}

function mount(extra: { learn?: boolean } = {}) {
  if (navigation) navigation.disableChildFrameNavigation = true
  const ignored: string[] = []
  const learned: string[] = []
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () =>
      createComponent(NikversePane, {
        picture: () => undefined,
        focused: false,
        onOpenSession: () => {},
        onFocusProject: () => {},
        onChord: () => {},
        onIgnored: (reason: string) => void ignored.push(reason),
        learn: extra.learn === false ? undefined : { progress: async () => undefined, ignored: (reason: string) => void learned.push(reason) },
      }),
    host,
  )
  const world = () => host.querySelector<HTMLIFrameElement>('iframe[data-slot="nikverse-frame"]')!
  const lesson = () => host.querySelector<HTMLIFrameElement>('iframe[data-slot="learn-frame"]')
  return { host, ignored, learned, world, lesson }
}

/** The world is up: its `hello` was answered with a port, and what ADE says on it is recorded. */
async function connectWorld(page: ReturnType<typeof mount>) {
  const frame = page.world()
  const seen = watch(frame)
  hello(seen.window, nonceOf(frame))
  await flush()
  expect(seen.offers).toHaveLength(1)
  const port = seen.offers[0]!
  const got = listen(port)
  return { frame, seen, port, got, say: (command: unknown) => port.postMessage({ type: "command", command }) }
}

const inLesson = (page: ReturnType<typeof mount>) => page.host.querySelector('[data-slot="nikverse-learn"]')

describe("a lesson over the world", () => {
  test("`open-learn` puts the lesson over the world, in ADE's DOM, and the world is paused under it", async () => {
    const page = mount()
    const world = await connectWorld(page)
    expect(inLesson(page)).toBeNull()
    world.say({ cmd: "open-learn", place: "faro" })
    await flush()
    expect(inLesson(page)).not.toBeNull()
    // The layer is ADE's DOM, never inside the world's frame, and the world's frame is still there, loaded.
    expect(inLesson(page)!.contains(page.world())).toBe(false)
    expect(page.world()).toBe(world.frame)
    expect(world.frame.isConnected).toBe(true)
    expect(world.got.map((m) => m.type)).toContain("pause")
    const src = new URL(page.lesson()!.src)
    expect(src.pathname).toEndWith("/learn/")
    const fragment = new URLSearchParams(src.hash.slice(1))
    expect(fragment.get("a")).toBe("percorsi")
    expect(fragment.get("l")).toMatch(/^(it|en)$/)
    expect(fragment.get("n")).toMatch(/^[0-9a-f]{32,}$/)
    expect(page.lesson()!.getAttribute("sandbox")).toBe("allow-scripts")
    // The bar: back to the world, export, import.
    const labels = [...page.host.querySelectorAll('[data-slot="learn-progress"] button')].map((b) => b.getAttribute("data-slot"))
    expect(labels).toEqual(["learn-back", "learn-export", "learn-import"])
  })

  test("`open-learn gioco` opens the page on the game, and a second `open-learn` while it is open changes nothing", async () => {
    const page = mount()
    const world = await connectWorld(page)
    world.say({ cmd: "open-learn", place: "gioco" })
    await flush()
    const first = page.lesson()!
    expect(new URLSearchParams(new URL(first.src).hash.slice(1)).get("a")).toBe("gioco")
    world.say({ cmd: "open-learn", place: "faro" })
    await flush()
    expect(page.lesson()).toBe(first)
    expect(world.got.filter((m) => m.type === "pause")).toHaveLength(1)
  })

  test("a place that is not the lighthouse or the kiosk opens nothing and is reported", async () => {
    const page = mount()
    const world = await connectWorld(page)
    world.say({ cmd: "open-learn", place: "percorsi" })
    world.say({ cmd: "open-learn" })
    await flush()
    expect(inLesson(page)).toBeNull()
    expect(page.ignored).toHaveLength(2)
  })

  test("the two frames have separate ports: a hello with the other one's nonce gets nothing, and only the owner's frame is told off", async () => {
    const page = mount()
    const world = await connectWorld(page)
    world.say({ cmd: "open-learn", place: "faro" })
    await flush()
    const lesson = page.lesson()!
    const lessonSeen = watch(lesson)
    const lessonNonce = nonceOf(lesson)
    const worldNonce = nonceOf(world.frame)
    expect(lessonNonce).not.toBe(worldNonce)
    page.ignored.length = 0
    page.learned.length = 0

    // The lesson's window with the world's nonce: no port to the lesson, one line for the lesson's side, none for the world's.
    hello(lessonSeen.window, worldNonce)
    await flush()
    expect(lessonSeen.offers).toHaveLength(0)
    expect(page.learned).toHaveLength(1)
    expect(page.ignored).toHaveLength(0)

    // The world's window with the lesson's nonce: no new port to the world, one line for the world's side, none for the lesson's.
    hello(world.seen.window, lessonNonce)
    await flush()
    expect(world.seen.offers).toHaveLength(1)
    expect(lessonSeen.offers).toHaveLength(0)
    expect(page.ignored).toHaveLength(1)
    expect(page.learned).toHaveLength(1)

    // Each with its own nonce is believed, and gets its own port: the lesson's does not reach the world's.
    hello(lessonSeen.window, lessonNonce)
    await flush()
    expect(lessonSeen.offers).toHaveLength(1)
    expect(world.seen.offers).toHaveLength(1)
    // A window that is neither is nobody's business: not even a line.
    const before = [page.ignored.length, page.learned.length]
    hello(window, lessonNonce)
    await flush()
    expect([page.ignored.length, page.learned.length]).toEqual(before)
  })

  test("closing with «Torna al mondo» takes the lesson frame and its port away, and the world resumes", async () => {
    const page = mount()
    const world = await connectWorld(page)
    world.say({ cmd: "open-learn", place: "faro" })
    await flush()
    const lesson = page.lesson()!
    const lessonSeen = watch(lesson)
    hello(lessonSeen.window, nonceOf(lesson))
    await flush()
    expect(lessonSeen.offers).toHaveLength(1)

    page.host.querySelector<HTMLButtonElement>('[data-slot="learn-back"]')!.click()
    await flush()
    expect(inLesson(page)).toBeNull()
    expect(page.lesson()).toBeNull()
    expect(lesson.isConnected).toBe(false)
    expect(page.world()).toBe(world.frame)
    expect(world.got.map((m) => m.type).filter((type) => type === "pause" || type === "resume")).toEqual(["pause", "resume"])
    // The listener is gone with the layer: the old frame's hello gets no port.
    hello(lessonSeen.window, nonceOf(lesson))
    await flush()
    expect(lessonSeen.offers).toHaveLength(1)
  })

  test("Esc in the page (`close` on its port) and Esc on the bar end in the same place", async () => {
    const page = mount()
    const world = await connectWorld(page)
    for (const how of ["page", "bar"] as const) {
      world.say({ cmd: "open-learn", place: "faro" })
      await flush()
      const lesson = page.lesson()!
      const seen = watch(lesson)
      hello(seen.window, nonceOf(lesson))
      await flush()
      if (how === "page") {
        // What the page does on Esc: `close` on the port it was given.
        seen.offers[0]!.postMessage({ type: "close" })
        await flush()
      } else {
        const bar = page.host.querySelector<HTMLElement>('[data-slot="learn-progress"]')!
        bar.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
        await flush()
      }
      expect([how, inLesson(page)]).toEqual([how, null])
      expect(page.world()).toBe(world.frame)
    }
    expect(world.got.map((m) => m.type).filter((type) => type === "pause" || type === "resume")).toEqual(["pause", "resume", "pause", "resume"])
  })

  test("a `close` that arrives after the layer is gone closes nothing", async () => {
    const page = mount()
    const world = await connectWorld(page)
    world.say({ cmd: "open-learn", place: "faro" })
    await flush()
    const lesson = page.lesson()!
    const seen = watch(lesson)
    hello(seen.window, nonceOf(lesson))
    await flush()
    const door = seen.offers[0]!
    page.host.querySelector<HTMLButtonElement>('[data-slot="learn-back"]')!.click()
    world.say({ cmd: "open-learn", place: "gioco" })
    await flush()
    // The new layer is open; the old page's door is shut and what it says now does not reach it.
    door.postMessage({ type: "close" })
    await flush()
    expect(inLesson(page)).not.toBeNull()
  })

  test("the panel hidden and seen again with the lesson open does not resume the world; closing the lesson does", async () => {
    const page = mount()
    const world = await connectWorld(page)
    world.say({ cmd: "open-learn", place: "faro" })
    await flush()
    const moves = () => world.got.map((m) => m.type).filter((type) => type === "pause" || type === "resume")
    expect(moves()).toEqual(["pause"])
    const state = (value: string) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value })
      document.dispatchEvent(new Event("visibilitychange"))
    }
    state("hidden")
    await flush()
    state("visible")
    await flush()
    // Under the lesson the world stays paused, whatever the panel did meanwhile.
    expect(moves()).toEqual(["pause"])
    page.host.querySelector<HTMLButtonElement>('[data-slot="learn-back"]')!.click()
    await flush()
    expect(moves()).toEqual(["pause", "resume"])
  })

  test("a lesson closed while the panel is hidden leaves the world paused until the panel is seen", async () => {
    const page = mount()
    const world = await connectWorld(page)
    world.say({ cmd: "open-learn", place: "faro" })
    await flush()
    const moves = () => world.got.map((m) => m.type).filter((type) => type === "pause" || type === "resume")
    const state = (value: string) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value })
      document.dispatchEvent(new Event("visibilitychange"))
    }
    state("hidden")
    page.host.querySelector<HTMLButtonElement>('[data-slot="learn-back"]')!.click()
    await flush()
    expect(moves()).toEqual(["pause"])
    state("visible")
    await flush()
    expect(moves()).toEqual(["pause", "resume"])
  })

  test("when the world's frame is let go after five minutes hidden, the lesson over it goes too", async () => {
    const held: (() => void)[] = []
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms !== UNLOAD_AFTER_MS) return realSetTimeout(fn, ms, ...rest)
      held.push(fn)
      return 1_000_000_000 + held.length
    }) as typeof setTimeout
    const page = mount()
    const world = await connectWorld(page)
    world.say({ cmd: "open-learn", place: "faro" })
    await flush()
    expect(inLesson(page)).not.toBeNull()
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" })
    document.dispatchEvent(new Event("visibilitychange"))
    await flush()
    expect(held).toHaveLength(1)
    held[0]!()
    await flush()
    expect(inLesson(page)).toBeNull()
    expect(page.world()).toBeNull()
    expect(page.host.querySelector('[data-slot="nikverse-unloaded"]')).not.toBeNull()
  })
})
