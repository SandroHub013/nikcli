import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { compileSolidJsx } from "../test-support/solid-jsx"

compileSolidJsx()
const { createComponent, createRoot, createSignal } = await import("solid-js")
const { render } = await import("solid-js/web")
const { Splash, FADE_MS } = await import("./splash")

/*
 * DS-26 (2026-11-02 audit), the user's choice B «Scuro con dissolvenza»: the
 * splash stays dark (the user approved the scene itself); the document is
 * painted ink until the shell's first frame, so nothing white or crema shows
 * behind it; and the splash crossfades into the shell over 400ms. With the
 * light theme every start used to fade a dark scene into a crema window.
 */
const here = import.meta.dir
const css = readFileSync(join(here, "splash.css"), "utf8")
const index = readFileSync(join(here, "..", "index.css"), "utf8")
const html = readFileSync(join(here, "..", "..", "index.html"), "utf8")

describe("the document is ink until the shell's first frame (DS-26)", () => {
  test("the page opens flagged as booting, so the first paint is ink", () => {
    expect(html).toMatch(/<html[^>]*\sdata-boot[\s>]/)
    expect(index).toMatch(/html\[data-boot\][^{]*\{[^}]*background:\s*var\(--ade-boot-ground\)/)
    expect(index).toMatch(/--ade-boot-ground:\s*#120d0b;/)
  })

  test("the flag is dropped when the splash starts to leave", () => {
    document.documentElement.setAttribute("data-boot", "")
    const container = document.createElement("div")
    document.body.appendChild(container)
    let setVisibleSignal!: (v: boolean) => void
    let disposeFn: (() => void) | undefined
    let unmount: (() => void) | undefined
    createRoot((dispose) => {
      disposeFn = dispose
      const [visible, setVisible] = createSignal(true)
      setVisibleSignal = setVisible
      unmount = render(
        () =>
          createComponent(Splash, {
            get visible() {
              return visible()
            },
          }),
        container,
      )
    })
    try {
      expect(document.documentElement.hasAttribute("data-boot")).toBe(true)
      setVisibleSignal(false)
      expect(document.documentElement.hasAttribute("data-boot")).toBe(false)
    } finally {
      unmount?.()
      disposeFn?.()
      container.remove()
      document.documentElement.removeAttribute("data-boot")
    }
  })
})

describe("the crossfade (DS-26)", () => {
  test("400ms, in one token that the stylesheet and the unmount both read", () => {
    expect(index).toMatch(/--ade-splash-fade:\s*400ms;/)
    expect(FADE_MS).toBe(400)
    expect(css).toMatch(/transition:\s*opacity\s+var\(--ade-splash-fade\)/)
  })

  test("reduced motion cuts the fade", () => {
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce\)\s*\{[^}]*transition:\s*none/)
  })
})

describe("the splash keeps its scene and its tokens (DS-26)", () => {
  test("the dark ground stays", () => {
    expect(css).toMatch(/color-scheme:\s*dark/)
    expect(css).toMatch(/background:\s*#211410/)
  })

  test("the status line reads --ade-text-weak, not a copy of its dark value", () => {
    const status = /\[data-slot="splash-status"\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? ""
    expect(status).toMatch(/color:\s*var\(--ade-text-weak\)/)
    expect(css.toLowerCase()).not.toContain("#9a907f")
  })
})

beforeEach(() => {
  document.body.innerHTML = ""
})
afterEach(() => {
  document.body.innerHTML = ""
})
