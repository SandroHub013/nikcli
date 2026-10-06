import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { WINDOW_IDLE_ATTRIBUTE, watchWindowIdle, windowIdle, type WindowIdleDeps } from "./window-idle"

/** A root that remembers its attributes, and a page the test can hide and show. */
function fakePage() {
  const attributes = new Set<string>()
  let hidden = false
  const listeners = new Set<() => void>()
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
    onVisibility: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    deps,
    idle: () => attributes.has(WINDOW_IDLE_ATTRIBUTE),
    hide: (next: boolean) => {
      hidden = next
      listeners.forEach((listener) => listener())
    },
    listeners: () => listeners.size,
  }
}

// Full review 2026-10-06, sessions 11: nothing loops for a window nobody can see, and only for that.
describe("the window idle attribute", () => {
  test("idle is out of sight, and only that: a window without focus is still looked at", () => {
    expect(windowIdle({ hidden: true })).toBe(true)
    expect(windowIdle({ hidden: false })).toBe(false)
  })

  test("hiding the page sets it and showing it takes it off", () => {
    const page = fakePage()
    watchWindowIdle(page.deps)
    expect(page.idle()).toBe(false)
    page.hide(true)
    expect(page.idle()).toBe(true)
    page.hide(false)
    expect(page.idle()).toBe(false)
  })

  test("a page that starts hidden is idle at once", () => {
    const page = fakePage()
    page.hide(true)
    watchWindowIdle(page.deps)
    expect(page.idle()).toBe(true)
  })

  test("stopping takes the attribute off and leaves no listener behind", () => {
    const page = fakePage()
    const stop = watchWindowIdle(page.deps)
    page.hide(true)
    expect(page.idle()).toBe(true)
    stop()
    expect(page.idle()).toBe(false)
    expect(page.listeners()).toBe(0)
  })

  test("the module does not listen to the window's focus", () => {
    const source = readFileSync(join(import.meta.dir, "window-idle.ts"), "utf-8")
    expect(source).not.toContain("onFocusChanged")
    expect(source).not.toContain('"blur"')
  })
})

/** Every css and tsx file under the packages ADE's surface is made of. */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name !== "node_modules" && name !== "dist") sources(path, out)
    } else if (/\.(css|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(path)
  }
  return out
}

describe("the loops and the sheet", () => {
  const packages = join(import.meta.dir, "..", "..", "..")
  const css = readFileSync(join(import.meta.dir, "..", "index.css"), "utf-8")

  test("the switch is a variable on the root, paused only under the attribute", () => {
    expect(css).toMatch(/:root\[data-window-idle\]\s*\{\s*--ade-loops: paused;/)
    // And not a blanket rule on every element: an entrance that starts while paused would stay at its first frame, invisible.
    expect(css).not.toMatch(/data-window-idle\][^{]*\*[^{]*\{[^}]*animation-play-state/)
  })

  test("every infinite animation of ADE's surface takes the switch, and no other animation does", () => {
    const wrong: string[] = []
    let loops = 0
    for (const dir of ["ade/src", "ui/src", "voice/src"]) {
      for (const file of sources(join(packages, dir))) {
        readFileSync(file, "utf-8")
          .split("\n")
          .forEach((line, index) => {
            if (!/(animation|--animate-[\w-]+)[^:]*:|`[^`]*\binfinite\b/.test(line) || !/\binfinite\b/.test(line)) return
            if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
            loops++
            if (!line.includes("var(--ade-loops")) wrong.push(`${file.slice(packages.length + 1)}:${index + 1}: ${line.trim()}`)
          })
      }
    }
    expect(wrong).toEqual([])
    expect(loops).toBeGreaterThan(20)
  })

  test("a one-time animation does not take it", () => {
    for (const file of ["../../../ui/src/components/toast.css", "../ui/layout.css", "../../../voice/src/ui/voice-hud.css"]) {
      const text = readFileSync(join(import.meta.dir, file), "utf-8")
      for (const line of text.split("\n")) {
        if (/animation:/.test(line) && !/\binfinite\b/.test(line)) expect(line, file).not.toContain("--ade-loops")
      }
    }
  })

  test("the surface watches the page while it is mounted", () => {
    const surface = readFileSync(join(import.meta.dir, "..", "ade-surface.tsx"), "utf-8")
    expect(surface).toContain("onMount(() => onCleanup(watchRealWindowIdle()))")
  })
})
