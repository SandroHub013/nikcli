import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { WINDOW_IDLE_ATTRIBUTE, watchWindowIdle, windowIdle, type WindowIdleDeps } from "./window-idle"

/** A root that remembers its attributes, and a window the test can focus, blur and hide. */
function fakeWindow(initialFocus: boolean | Promise<boolean> = true) {
  const attributes = new Set<string>()
  let hidden = false
  const focusListeners = new Set<(focused: boolean) => void>()
  const visibilityListeners = new Set<() => void>()
  const deps: WindowIdleDeps = {
    root: {
      toggleAttribute: (name, force) => {
        const on = force ?? !attributes.has(name)
        if (on) attributes.add(name)
        else attributes.delete(name)
        return on
      },
    },
    hidden: () => hidden,
    focused: () => initialFocus,
    onFocus: (listener) => {
      focusListeners.add(listener)
      return () => focusListeners.delete(listener)
    },
    onVisibility: (listener) => {
      visibilityListeners.add(listener)
      return () => visibilityListeners.delete(listener)
    },
  }
  return {
    deps,
    idle: () => attributes.has(WINDOW_IDLE_ATTRIBUTE),
    focus: (focused: boolean) => focusListeners.forEach((listener) => listener(focused)),
    hide: (next: boolean) => {
      hidden = next
      visibilityListeners.forEach((listener) => listener())
    },
    listeners: () => focusListeners.size + visibilityListeners.size,
  }
}

// Full review 2026-10-06, sessions 11: no animation with ADE covered.
describe("the window idle attribute", () => {
  test("idle is out of sight or without the focus", () => {
    expect(windowIdle({ focused: true, hidden: false })).toBe(false)
    expect(windowIdle({ focused: false, hidden: false })).toBe(true)
    expect(windowIdle({ focused: true, hidden: true })).toBe(true)
  })

  test("losing the focus sets it and gaining it takes it off", () => {
    const window = fakeWindow()
    watchWindowIdle(window.deps)
    expect(window.idle()).toBe(false)
    window.focus(false)
    expect(window.idle()).toBe(true)
    window.focus(true)
    expect(window.idle()).toBe(false)
  })

  test("a hidden page is idle even with the focus, and comes back when shown", () => {
    const window = fakeWindow()
    watchWindowIdle(window.deps)
    window.hide(true)
    expect(window.idle()).toBe(true)
    window.hide(false)
    expect(window.idle()).toBe(false)
  })

  test("a window that starts without the focus is idle once that is known, and not before", async () => {
    const window = fakeWindow(Promise.resolve(false))
    watchWindowIdle(window.deps)
    expect(window.idle()).toBe(false)
    await Promise.resolve()
    await Promise.resolve()
    expect(window.idle()).toBe(true)
  })

  test("stopping takes the attribute off and leaves no listener behind", () => {
    const window = fakeWindow()
    const stop = watchWindowIdle(window.deps)
    window.focus(false)
    expect(window.idle()).toBe(true)
    stop()
    expect(window.idle()).toBe(false)
    expect(window.listeners()).toBe(0)
  })
})

describe("the sheet under the attribute", () => {
  const css = readFileSync(join(import.meta.dir, "..", "index.css"), "utf-8")

  test("pauses every animation, pseudo-elements included", () => {
    expect(css).toContain(":root[data-window-idle] *,")
    expect(css).toContain(":root[data-window-idle] *::before,")
    expect(css).toContain(":root[data-window-idle] *::after {\n  animation-play-state: paused !important;")
  })

  test("the surface watches the window while it is mounted", () => {
    const surface = readFileSync(join(import.meta.dir, "..", "ade-surface.tsx"), "utf-8")
    expect(surface).toContain("onMount(() => onCleanup(watchRealWindowIdle()))")
  })
})
