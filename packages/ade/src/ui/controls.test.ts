import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { compileSolidJsx } from "../test-support/solid-jsx"
import { resetLocaleForTests } from "../i18n/locale"
import {
  BUTTON_VARIANTS,
  CONTROL_SIZES,
  buttonAttrs,
  emptyStateAttrs,
  fieldAttrs,
  iconButtonAttrs,
  noticeAttrs,
} from "./control-attrs"

if (typeof document === "undefined") GlobalRegistrator.register()
compileSolidJsx()

const { createComponent, render } = await import("solid-js/web")
const { Button, EmptyState, Field, IconButton, Notice } = await import("./controls")
const { t } = await import("../i18n")

const css = readFileSync(new URL("./controls.css", import.meta.url), "utf8")
const index = readFileSync(new URL("../index.css", import.meta.url), "utf8")
const sansComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "")

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
})
afterAll(() => resetLocaleForTests("it"))

function mount(view: () => unknown) {
  resetLocaleForTests("it")
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(view as () => import("solid-js").JSX.Element, host)
  return host
}

describe("the attributes", () => {
  test("a button is secondary and medium until it says otherwise", () => {
    expect(buttonAttrs()).toEqual({
      "data-ui": "button",
      "data-variant": "secondary",
      "data-size": "md",
      "aria-busy": undefined,
    })
  })

  test("every variant and size is spelled once, in the vocabulary the sheet matches", () => {
    for (const variant of BUTTON_VARIANTS) expect(buttonAttrs({ variant })["data-variant"]).toBe(variant)
    for (const size of CONTROL_SIZES) expect(buttonAttrs({ size })["data-size"]).toBe(size)
    // The stylesheet knows the same words: a variant added to the type and not to the sheet is an unstyled button.
    for (const variant of BUTTON_VARIANTS.filter((v) => v !== "secondary"))
      expect(css).toContain(`[data-ui="button"][data-variant="${variant}"]`)
    for (const size of CONTROL_SIZES.filter((s) => s !== "md"))
      expect(css).toContain(`[data-ui="button"][data-size="${size}"]`)
  })

  test("loading is aria-busy, and only loading", () => {
    expect(buttonAttrs({ loading: true })["aria-busy"]).toBe("true")
    expect(buttonAttrs({ loading: false })["aria-busy"]).toBeUndefined()
  })

  test("a field is invalid for assistive technology, not only for the eye", () => {
    expect(fieldAttrs({ invalid: true })["aria-invalid"]).toBe("true")
    expect(fieldAttrs()["aria-invalid"]).toBeUndefined()
    expect(fieldAttrs({ shape: "pill" })["data-shape"]).toBe("pill")
  })

  test("an error notice is an alert and the others are a status (UX-20)", () => {
    expect(noticeAttrs("error").role).toBe("alert")
    expect(noticeAttrs("info").role).toBe("status")
    expect(noticeAttrs("working").role).toBe("status")
    expect(noticeAttrs().role).toBe("status")
  })

  test("icon buttons and empty states carry their marker", () => {
    expect(iconButtonAttrs()).toEqual({ "data-ui": "icon-button", "data-size": "md" })
    expect(emptyStateAttrs()).toEqual({ "data-ui": "empty-state" })
  })
})

describe("the stylesheet", () => {
  const rules = sansComments(css)

  test("every rule costs no specificity, so a surface can adjust without a fight", () => {
    const selectors = rules
      .split("}")
      .map((block) => block.split("{")[0]!.trim())
      .filter((selector) => selector && !selector.startsWith("@") && !/^(from|to)$/.test(selector))
    // A selector is either :where(...) from the start or the keyframes step it is inside.
    const loose = selectors.filter((selector) => !selector.startsWith(":where(") && !selector.startsWith("@"))
    expect(loose).toEqual([])
  })

  test("heights come from the control tokens, never from a literal", () => {
    expect(rules).toContain("height: var(--ade-control-sm)")
    expect(rules).toContain("height: var(--ade-control-md)")
    expect(rules).toContain("height: var(--ade-control-lg)")
    expect(rules).not.toMatch(/\bheight:\s*\d+px/)
    expect(index).toContain("--ade-control-sm: 22px")
    expect(index).toContain("--ade-control-md: 26px")
    expect(index).toContain("--ade-control-lg: 32px")
  })

  test("a disabled control is one opacity, from the token", () => {
    // Every `:disabled` rule dims with the token; the spinner's reduced-motion opacity is not a disabled look.
    const disabled = rules.split("}").filter((block) => /:disabled\)\s*\{/.test(block) && !block.includes("busy"))
    expect(disabled.length).toBeGreaterThanOrEqual(3)
    for (const block of disabled) expect(block).toContain("opacity: var(--ade-disabled-opacity)")
    expect(index).toContain("--ade-disabled-opacity: 0.45")
    expect(rules.match(/opacity: var\(--ade-disabled-opacity\)/g)?.length).toBeGreaterThanOrEqual(3)
  })

  test("a press is the token, and an icon under 24px answers with the ground alone", () => {
    expect(rules).toContain('[data-ui="button"]:active:not(:disabled)) {\n  transform: var(--ade-press)')
    const small = rules.slice(rules.indexOf('[data-ui="icon-button"]:active:not(:disabled)'))
    expect(small.slice(0, small.indexOf("}"))).not.toContain("transform")
  })

  test("a small icon button has a hit area of at least 24px (UX-18)", () => {
    expect(index).toContain("--ade-control-icon-sm: 20px")
    // 20 + 2 * 2: the ::before reaches two pixels past the glyph's box on every side.
    expect(rules).toContain('[data-ui="icon-button"][data-size="sm"])::before')
    expect(rules).toMatch(/\[data-ui="icon-button"\]\[data-size="sm"\]\)::before \{[^}]*inset: -2px/)
  })

  test("loading draws a spinner that the loop switch can stop, and holds still under reduced motion", () => {
    expect(rules).toMatch(/animation: ade-button-spin [^;]*infinite var\(--ade-loops, running\)/)
    const reduced = rules.slice(rules.indexOf("@media (prefers-reduced-motion: reduce)"))
    expect(reduced).toContain("animation: none")
  })

  test("the control border is 3:1 or more on every ground, in both themes (WCAG 1.4.11)", () => {
    const pair = (name: string) => {
      const match = index.match(new RegExp(`${name}:\\s*light-dark\\((#[0-9a-f]{6}),\\s*(#[0-9a-f]{6})\\)`))
      expect(match).not.toBeNull()
      return { light: match![1]!, dark: match![2]! }
    }
    const luminance = (hex: string) => {
      const value = parseInt(hex.slice(1), 16)
      const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => {
        const c = channel / 255
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
    }
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
      return (hi! + 0.05) / (lo! + 0.05)
    }
    const border = pair("--ade-control-border")
    for (const ground of ["--ade-bg", "--ade-sunken", "--ade-surface", "--ade-raised", "--ade-overlay"]) {
      const colours = pair(ground)
      expect({ ground, theme: "light", ok: ratio(border.light, colours.light) >= 3 }).toEqual({
        ground,
        theme: "light",
        ok: true,
      })
      expect({ ground, theme: "dark", ok: ratio(border.dark, colours.dark) >= 3 }).toEqual({
        ground,
        theme: "dark",
        ok: true,
      })
    }
  })

  test("an invalid field is drawn with the error colour", () => {
    expect(rules).toContain('[data-ui="field"][aria-invalid="true"]) {\n  border-color: var(--ade-error)')
  })

  test("focus survives a Windows contrast theme: the global rule keeps an outline (UX-19)", () => {
    const global = sansComments(index).slice(sansComments(index).indexOf("\n:focus-visible {"))
    expect(global.slice(0, global.indexOf("}"))).toContain("outline: 2px solid transparent")
    expect(global).toMatch(/@media \(forced-colors: active\)\s*\{\s*:focus-visible\s*\{[^}]*outline: 2px solid Highlight !important/)
  })

  test("a field's edge is the control border, which is 3:1 against its grounds (UX-19)", () => {
    expect(rules).toContain("border: 1px solid var(--ade-control-border)")
    expect(index).toContain("--ade-control-border: light-dark(#80755f, #7d7367)")
  })
})

describe("Button", () => {
  test("renders a real, typed button with the markers and its own props", () => {
    const host = mount(() =>
      createComponent(Button, { variant: "primary", size: "lg", "data-slot": "mine", children: "Go" }),
    )
    const button = host.querySelector("button")!
    expect(button.type).toBe("button")
    expect(button.getAttribute("data-ui")).toBe("button")
    expect(button.getAttribute("data-variant")).toBe("primary")
    expect(button.getAttribute("data-size")).toBe("lg")
    // The surface keeps its own slot: its tests and its layout rules still find it.
    expect(button.getAttribute("data-slot")).toBe("mine")
    expect(button.textContent).toBe("Go")
  })

  test("a press runs the handler, and a disabled one does not", () => {
    let presses = 0
    const host = mount(() =>
      createComponent(Button, { onClick: () => presses++, disabled: true, children: "Go" }),
    )
    const button = host.querySelector("button")!
    expect(button.disabled).toBe(true)
    button.click()
    expect(presses).toBe(0)
    button.disabled = false
    button.click()
    expect(presses).toBe(1)
  })

  test("loading is busy and refuses the press, with the label still in the box", () => {
    let presses = 0
    const host = mount(() => createComponent(Button, { loading: true, onClick: () => presses++, children: "Save" }))
    const button = host.querySelector("button")!
    expect(button.getAttribute("aria-busy")).toBe("true")
    expect(button.disabled).toBe(true)
    expect(button.textContent).toBe("Save")
    button.click()
    expect(presses).toBe(0)
  })
})

describe("IconButton", () => {
  test("is named by its label, which is also its tooltip", () => {
    const host = mount(() => createComponent(IconButton, { label: "Chiudi", children: "x" }))
    const button = host.querySelector("button")!
    expect(button.getAttribute("aria-label")).toBe("Chiudi")
    expect(button.title).toBe("Chiudi")
    expect(button.getAttribute("data-size")).toBe("md")
  })

  test("takes the small size", () => {
    const host = mount(() => createComponent(IconButton, { label: "Chiudi", size: "sm", children: "x" }))
    expect(host.querySelector("button")!.getAttribute("data-size")).toBe("sm")
  })
})

describe("Field", () => {
  test("an invalid field says so and points at its message", () => {
    const host = mount(() =>
      createComponent(Field, { id: "name", invalid: true, message: "Obbligatorio", value: "" }),
    )
    const input = host.querySelector("input")!
    expect(input.getAttribute("aria-invalid")).toBe("true")
    expect(input.getAttribute("aria-describedby")).toBe("name-message")
    expect(host.querySelector("#name-message")?.textContent).toBe("Obbligatorio")
  })

  test("a valid field has neither the flag nor the message", () => {
    const host = mount(() => createComponent(Field, { id: "name", message: "Obbligatorio", value: "" }))
    const input = host.querySelector("input")!
    expect(input.getAttribute("aria-invalid")).toBeNull()
    expect(input.getAttribute("aria-describedby")).toBeNull()
    expect(host.querySelector('[data-ui="field-message"]')).toBeNull()
  })

  test("the pill shape and the small size are attributes", () => {
    const host = mount(() => createComponent(Field, { shape: "pill", size: "sm" }))
    const input = host.querySelector("input")!
    expect(input.getAttribute("data-shape")).toBe("pill")
    expect(input.getAttribute("data-size")).toBe("sm")
  })
})

describe("Notice", () => {
  test("an error is an alert and an info is a status", () => {
    const error = mount(() => createComponent(Notice, { tone: "error", children: "No" }))
    expect(error.querySelector('[data-ui="notice"]')!.getAttribute("role")).toBe("alert")
    dispose?.()
    document.body.innerHTML = ""
    const info = mount(() => createComponent(Notice, { children: "Fatto" }))
    expect(info.querySelector('[data-ui="notice"]')!.getAttribute("role")).toBe("status")
  })

  test("closes through a named icon button", () => {
    let closed = 0
    const host = mount(() => createComponent(Notice, { onClose: () => closed++, children: "Fatto" }))
    const close = host.querySelector<HTMLButtonElement>('[data-ui="icon-button"]')!
    expect(close.getAttribute("aria-label")).toBe(t("ui.notice.close"))
    close.click()
    expect(closed).toBe(1)
  })

  test("names what the close control discards, when asked", () => {
    const host = mount(() =>
      createComponent(Notice, { onClose: () => {}, closeLabel: "Scarta: Fatto", children: "Fatto" }),
    )
    expect(host.querySelector('[data-ui="icon-button"]')!.getAttribute("aria-label")).toBe("Scarta: Fatto")
  })

  test("has no close control unless it is given a handler", () => {
    const host = mount(() => createComponent(Notice, { children: "Fatto" }))
    expect(host.querySelector("button")).toBeNull()
  })

  test("an action is a ghost button", () => {
    let pressed = 0
    const host = mount(() =>
      createComponent(Notice, { action: { label: "Riprova", onClick: () => pressed++ }, children: "Errore" }),
    )
    const action = host.querySelector<HTMLButtonElement>('[data-ui="button"]')!
    expect(action.getAttribute("data-variant")).toBe("ghost")
    action.click()
    expect(pressed).toBe(1)
  })
})

describe("EmptyState", () => {
  test("a mark, a title, a line of help and one primary action", () => {
    let pressed = 0
    const host = mount(() =>
      createComponent(EmptyState, {
        title: "Niente qui",
        action: { label: "Crea", onClick: () => pressed++ },
        children: "Non c'è ancora nulla.",
      }),
    )
    expect(host.querySelector('[data-ui="empty-title"]')!.textContent).toBe("Niente qui")
    expect(host.querySelector('[data-ui="empty-body"]')!.textContent).toBe("Non c'è ancora nulla.")
    const action = host.querySelector<HTMLButtonElement>('[data-ui="button"]')!
    expect(action.getAttribute("data-variant")).toBe("primary")
    action.click()
    expect(pressed).toBe(1)
  })

  test("without help or action it is just the title", () => {
    const host = mount(() => createComponent(EmptyState, { title: "Niente qui" }))
    expect(host.querySelector('[data-ui="empty-body"]')).toBeNull()
    expect(host.querySelector("button")).toBeNull()
  })
})
