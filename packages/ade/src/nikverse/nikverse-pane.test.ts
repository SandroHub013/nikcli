import { afterEach, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { compileSolidJsx } from "../test-support/solid-jsx"
import { OPEN_TIMEOUT_MS } from "./opening"

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
afterEach(() => {
  dispose?.()
  dispose = undefined
  if (navigation && childFrames !== undefined) navigation.disableChildFrameNavigation = childFrames
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
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
