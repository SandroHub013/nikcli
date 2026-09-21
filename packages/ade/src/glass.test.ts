import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

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
      '[data-component="ade-shell"][data-theme="glass"] [data-slot="ade-bar"]',
    ])
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
    expect(token("--ade-overlay")).toMatch(/^rgba\(36, 32, 32, calc\(/)
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

describe("leggibilità del vetro al minimo", () => {
  /*
   * The worst case S49 fixed and this must not undo: the slider at 0 over a
   * white desktop. Between the text and that white there is the floor plus
   * the reading ground, and nothing else — so this is where the reading
   * ground earns its 0.64.
   */
  const veil = /rgba\((\d+), (\d+), (\d+), calc\(([\d.]+)/.exec(token("--ade-glass-veil"))
  const base = veil ? [Number(veil[1]), Number(veil[2]), Number(veil[3])] : []
  const floor = veil ? Number(veil[4]) : 0
  const read = Number(/rgba\(\d+, \d+, \d+, ([\d.]+)\)/.exec(token("--ade-glass-read"))?.[1] ?? 0)
  // What text actually sits on: the floor with the reading ground over it.
  const readingAlpha = floor + read * (1 - floor)
  const over = (background: number[], alphaOf: number) =>
    background.map((channel, i) => Math.round(255 * (1 - alphaOf) + channel * alphaOf))

  test("i tre livelli di testo stanno sopra 4,5:1 su scrivania bianca", () => {
    const ground = over(base, readingAlpha)
    for (const name of ["--ade-text", "--ade-text-soft", "--ade-text-weak"]) {
      expect([name, contrast(channels(token(name)), ground) >= 4.5]).toEqual([name, true])
    }
  })

  test("valgono anche sul rialzo del 6%", () => {
    // The lift brightens the glass, which is the direction that costs contrast.
    const lift = over(base, readingAlpha).map((channel) => Math.round(channel * 0.94 + 255 * 0.06))
    for (const name of ["--ade-text", "--ade-text-soft", "--ade-text-weak"]) {
      expect([name, contrast(channels(token(name)), lift) >= 4.5]).toEqual([name, true])
    }
  })
})
