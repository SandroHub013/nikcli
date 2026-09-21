import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { GLASS_READABLE_MIN } from "./theme"

/*
 * The glass theme, as a rule rather than as a list.
 *
 * 0.7.3 shipped with the veil painted by every container and a closed list of
 * components excused from it, so only what was on the list read as glass:
 * measured in ADE Test on a white desktop with the slider at its minimum, the
 * shell read alpha 0.73 while the sidebar and the shot tray read 0.99 — opaque.
 * Removing the list was not enough, because the veil itself started at 0.68:
 * no position of the slider let the desktop through. So there are two layers
 * now — a low floor for the window, a reading ground where the text is — and
 * these tests hold both the floor and the readability in place.
 */
const css = readFileSync(join(import.meta.dir, "index.css"), "utf8")
/* Comments carry braces and prose; they are not rules. */
const rulesOnly = css.replace(/\/\*[\s\S]*?\*\//g, "")

/** The `[data-theme="glass"]` token block. */
const glassTokens = (() => {
  const start = css.indexOf('[data-component="ade-shell"][data-theme="glass"],')
  return css.slice(start, css.indexOf("}", start))
})()

/** Every rule whose selector is scoped to the glass theme. */
function glassRules(): { selector: string; body: string }[] {
  const rules: { selector: string; body: string }[] = []
  const pattern = /([^{}]+)\{([^{}]*)\}/g
  for (const match of rulesOnly.matchAll(pattern)) {
    const selector = match[1].trim()
    if (selector.includes('data-theme="glass"')) rules.push({ selector, body: match[2] })
  }
  return rules
}

/** Relative luminance, then the WCAG ratio. */
function luminance([r, g, b]: number[]): number {
  const channel = (value: number) => {
    const v = value / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(a: number[], b: number[]): number {
  const [hi, lo] = luminance(a) > luminance(b) ? [luminance(a), luminance(b)] : [luminance(b), luminance(a)]
  return (hi + 0.05) / (lo + 0.05)
}

/** `#rrggbb` or `rgba(r, g, b, …)` as three channels. */
function channels(colour: string): number[] {
  const hex = /#([0-9a-f]{6})/i.exec(colour)
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16))
  const rgb = /rgba?\(([^)]+)\)/.exec(colour)
  if (!rgb) throw new Error(`colore non leggibile: ${colour}`)
  return rgb[1].split(",").slice(0, 3).map((part) => Number(part.trim()))
}

function token(name: string): string {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(glassTokens)
  if (!match) throw new Error(`manca il token ${name}`)
  return match[1].trim()
}

describe("il tema vetro vale per default", () => {
  test("i contenitori non dipingono: sono i token a essere trasparenti", () => {
    for (const name of ["--ade-bg", "--ade-sunken", "--ade-surface", "--ade-terminal-bg"]) {
      expect([name, token(name)]).toEqual([name, "transparent"])
    }
  })

  test("il fondo della finestra è dipinto una volta sola", () => {
    const painters = glassRules().filter(({ body }) => /background:[^;]*--ade-glass-veil/.test(body))
    expect(painters.map((rule) => rule.selector)).toEqual([
      '[data-component="ade-shell"][data-theme="glass"]',
    ])
  })

  test("il fondo di lettura lo aggiungono gli slot del guscio, non i componenti", () => {
    /*
     * The second layer is what makes text legible over a floor this low, so
     * it may be added once, by places in the shell — a grid cell's child, the
     * sidebar, the bar. If a component's name ever appears here, a panel written
     * next week is illegible until someone remembers to add it.
     */
    const grounds = glassRules().filter(({ body }) => /background:[^;]*--ade-glass-read/.test(body))
    const selectors = grounds.flatMap((rule) => rule.selector.split(",").map((part) => part.trim()))
    expect(selectors).toEqual([
      '[data-component="ade-shell"][data-theme="glass"] [data-component="ade-sidebar"]',
      '[data-component="ade-shell"][data-theme="glass"] [data-slot="grid-cell"] > [data-component]',
      '[data-component="ade-shell"][data-theme="glass"] [data-slot="ade-main"] > [data-component]:not(:has([data-slot="grid-cell"]))',
      '[data-component="ade-shell"][data-theme="glass"] [data-slot="ade-bar"]',
    ])
  })

  test("anche una vista che riempie l'area centrale ha il suo fondo", () => {
    /*
     * The reviewer's catch. Not everything in `ade-main` is a grid cell: the
     * agent console, the chat, the bots view, the new-session and
     * empty-project screens are its children directly, and with only the
     * grid-cell line they sat on the bare floor — 1.23:1 at the minimum.
     * Measured after the fix, the agent console reads alpha 0.67 and its three
     * text levels 6.27 / 5.34 / 5.10:1.
     */
    const main = glassRules().find(({ selector }) => selector.includes('[data-slot="ade-main"] > [data-component]'))
    expect(main).toBeDefined()
    expect(main!.body).toMatch(/--ade-glass-read/)
  })

  test("chi ospita celle lascia dipingere le celle, così non ci sono due fondi", () => {
    /*
     * The session grid fills the main area too. If it took the ground as well,
     * every pane would sit on two of them — 0.88 at the slider's minimum,
     * which is the opacity this whole change exists to get rid of. The shape,
     * not a name, is what keeps it out.
     */
    const main = glassRules().find(({ selector }) => selector.includes('[data-slot="ade-main"] > [data-component]'))
    const line = main!.selector
      .split(",")
      .map((part) => part.trim())
      .find((part) => part.includes('[data-slot="ade-main"]'))
    expect(line).toContain(':not(:has([data-slot="grid-cell"]))')
    expect(line).not.toContain("session-grid")
  })

  test("quello che galleggia sopra il contenuto ha un fondo suo", () => {
    /*
     * The new-pane menu painted `--ade-raised`, a 6% lift, and opened as clear
     * glass over the panes: the user's screenshot has terminal lines running
     * through the words of the menu. Measured over a live terminal at the
     * slider's minimum, the menu's ground was alpha 0.14 and its items read
     * 1.18:1; with the rule below, 0.93 and 13.97:1.
     *
     * The roles are the shape of "this floats over other content", so a menu
     * written next week is covered for being a menu.
     */
    const floating = glassRules().filter(({ body }) => /background:[^;]*--ade-overlay/.test(body))
    const selectors = floating.flatMap((rule) => rule.selector.split(",").map((part) => part.trim()))
    for (const role of ["menu", "dialog", "listbox", "tooltip"]) {
      expect([role, selectors.some((one) => one.endsWith(`[role="${role}"]`))]).toEqual([role, true])
    }
    expect(selectors.some((one) => one.endsWith("[popover]"))).toBe(true)
  })

  test("il fondo dei menu non segue il cursore", () => {
    /*
     * A menu is opened to be read, over whatever is underneath. Dragging the
     * glass to its most extreme may take the window's own veil away; it may
     * not take that.
     */
    expect(token("--ade-overlay")).not.toContain("--ade-glass-opacity")
    const alpha = Number(/rgba\(\d+, \d+, \d+, ([\d.]+)\)/.exec(token("--ade-overlay"))![1])
    expect(alpha).toBeGreaterThanOrEqual(0.9)
  })

  test("il pavimento parte abbastanza in basso da lasciar vedere la scrivania", () => {
    /*
     * Fabio, trying it live: at 0.68 there is no position of the slider that
     * is not two thirds paint. A floor is only a floor if you can see through
     * it; a third of the desktop is the least that reads as glass at all.
     */
    const veil = /calc\(([\d.]+) \+ ([\d.]+) \*/.exec(token("--ade-glass-veil"))
    expect(veil).not.toBeNull()
    const floor = Number(veil![1])
    const ceiling = floor + Number(veil![2])
    expect(floor).toBeLessThanOrEqual(0.2)
    expect(ceiling).toBeLessThanOrEqual(0.9)
  })

  test("non c'è un elenco di componenti da ricordare", () => {
    /*
     * Being transparent must not depend on being named here: a panel written
     * next week has to be born transparent. Only the document around the
     * shell — which has no tokens to make transparent — may be named.
     */
    const exempted = glassRules().filter(({ body }) => /background:\s*transparent\s*!important/.test(body))
    for (const rule of exempted) {
      for (const selector of rule.selector.split(",").map((part) => part.trim())) {
        expect([selector, /^(html|body|:root)(\[data-theme="glass"\])?( (body|#root))?$/.test(selector)]).toEqual([
          selector,
          true,
        ])
      }
    }
  })

  test("le uniche eccezioni opache sono quelle scritte", () => {
    /*
     * `raised` is a 6% white lift, not a veil; `overlay` is a real veil
     * because menus and dialogs cover the content they sit on. Anything else
     * turning opaque here is a regression, and the comment above the block
     * has to say why before this list grows.
     */
    expect(token("--ade-raised")).toBe("rgba(255, 255, 255, 0.06)")
    // Fixed, not a curve: see «il fondo dei menu non segue il cursore».
    expect(token("--ade-overlay")).toMatch(/^rgba\(\d+, \d+, \d+, 0\.9\d*\)$/)
    expect(glassTokens).toContain("--ade-glass-veil")
  })

  test("il blur sta col velo, non sui contenitori trasparenti", () => {
    /*
     * A `backdrop-filter` over an empty backdrop paints its own grey: with the
     * blur still on the bar and the sidebar, those read rgb(53,51,51) against
     * the rgb(80,79,79) of the glass beside them.
     */
    const blurred = glassRules().filter(({ body }) => /(^|\s|-)backdrop-filter:/.test(body))
    expect(blurred.map((rule) => rule.selector)).toEqual([
      '[data-component="ade-shell"][data-theme="glass"]',
    ])
  })
})

describe("leggibilità lungo il cursore", () => {
  /*
   * Both layers follow the slider now, so readability is not one number but a
   * curve, and the question is where it crosses 4.5:1. That crossing is what
   * the settings panel promises, so it is checked here against the curves
   * themselves rather than written down twice.
   */
  const veil = /rgba\((\d+), (\d+), (\d+), calc\(([\d.]+) \+ ([\d.]+) \*/.exec(token("--ade-glass-veil"))
  const base = [Number(veil![1]), Number(veil![2]), Number(veil![3])]
  const veilAt = (slider: number) => Number(veil![4]) + Number(veil![5]) * slider

  // The `pow()` line wins the cascade; the linear one above it is the fallback.
  const readDecl = [...glassTokens.matchAll(/--ade-glass-read:\s*([^;]+);/g)].pop()![1]
  const readCurve = /calc\(([\d.]+) \+ ([\d.]+) \* pow\(var\([^)]+\), ([\d.]+)\)\)/.exec(readDecl)
  const readAt = (slider: number) =>
    Number(readCurve![1]) + Number(readCurve![2]) * slider ** Number(readCurve![3])

  /** The ground text sits on: floor, reading ground, and the 6% lift over it. */
  function ground(slider: number, lift: boolean): number[] {
    const alpha = veilAt(slider) + readAt(slider) * (1 - veilAt(slider))
    const composed = base.map((channel) => 255 * (1 - alpha) + channel * alpha)
    return (lift ? composed.map((channel) => channel * 0.94 + 255 * 0.06) : composed).map(Math.round)
  }

  const worst = (slider: number) =>
    Math.min(
      ...["--ade-text", "--ade-text-soft", "--ade-text-weak"].map((name) =>
        contrast(channels(token(name)), ground(slider, true)),
      ),
    )

  test("il pannello promette il punto giusto: da GLASS_READABLE_MIN in su si legge", () => {
    /*
     * `settings.theme.opacityDesc` says text stays above the minimum contrast
     * from GLASS_READABLE_MIN up. If the curves move and this is not checked,
     * the panel starts lying — which is the failure this whole spec began with.
     */
    expect(worst(GLASS_READABLE_MIN / 100)).toBeGreaterThanOrEqual(4.5)
    for (const percent of [GLASS_READABLE_MIN, 30, 50, 75, 100]) {
      expect([percent, worst(percent / 100) >= 4.5]).toEqual([percent, true])
    }
  })

  test("e appena sotto non si legge: la soglia è dove dice di essere", () => {
    // Otherwise the number could be set anywhere above the real crossing and
    // the test would still pass, while the slider lost usable positions.
    expect(worst((GLASS_READABLE_MIN - 1) / 100)).toBeLessThan(4.5)
  })

  test("in fondo il vetro è davvero spinto", () => {
    /*
     * The state the user asked to have back: at 0 the desktop is essentially
     * unpainted — alpha around 0.11, contrast around 1.2:1. A reading ground
     * that stayed high down there would make the slider a choice between
     * legible and slightly-more-legible, which is what it used to be.
     */
    const alpha = veilAt(0) + readAt(0) * (1 - veilAt(0))
    expect(alpha).toBeLessThan(0.2)
    expect(worst(0)).toBeLessThan(1.5)
  })

  test("in cima si legge benissimo", () => {
    expect(worst(1)).toBeGreaterThan(9)
  })
})
