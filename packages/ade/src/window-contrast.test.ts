import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import postcss from "postcss"

/*
 * The windows' colour contrast, pinned from the sheets (contrasti, 2026-11-02).
 *
 * The live measure of ADE Test (`results/contrasti-finestre-2026-11-02.md`) found 31 text pairs under AA, field
 * boundaries at 1.2 to 2.05:1 and a few icons under 3:1. This file holds each of them from drifting back, per theme:
 * light, dark and glass.
 *
 * What it cannot see, and the live script can: a ground that is a gradient or a `backdrop-filter` (the glass), the
 * pixels behind a translucent surface, a colour held from the previous theme by an element the capture could not see (three of the live rows were
 * that), and an SVG paint server (`url(#gradient)`, a mask). So the glass is computed on the grounds the report
 * measured plus the brightest the sheet can make (the reading ground over a white desktop), and the sheets' own
 * formulas are read here, not copied.
 */

const src = import.meta.dir
const voice = join(src, "..", "..", "voice", "src")
const read = (file: string) => readFileSync(join(src, file), "utf-8")
const sheet = (file: string) => postcss.parse(read(file))

type Rgb = [number, number, number]
type Rgba = [number, number, number, number]
type Scheme = "light" | "dark" | "glass"

function lin(channel: number): number {
  const c = channel / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const lum = ([r, g, b]: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
function ratio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}
const hex = (value: string): Rgb => {
  const h = value.trim().replace("#", "")
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb
}
/** `#rrggbb` or `rgba(r, g, b, a)` as four numbers. */
function color(value: string): Rgba {
  const v = value.trim()
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v)
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), rgba[4] === undefined ? 1 : Number(rgba[4])]
  return [...hex(v), 1]
}
const over = ([r, g, b, a]: Rgba, ground: Rgb): Rgb => [
  r * a + ground[0] * (1 - a),
  g * a + ground[1] * (1 - a),
  b * a + ground[2] * (1 - a),
]
const rgb = (c: Rgba | Rgb): Rgb => [c[0], c[1], c[2]]

/** A `:root` token written as `light-dark(a, b)`, or a plain value, as one colour per scheme. */
function token(name: string, scheme: "light" | "dark"): Rgba {
  let found: string | undefined
  sheet("index.css").walkRules(":root", (rule) => {
    rule.walkDecls(name, (decl) => {
      found ??= decl.value
    })
  })
  if (found === undefined) throw new Error(`${name} is not declared on :root`)
  const pair = /^light-dark\(\s*(#[0-9a-f]{6}|rgba?\([^)]*\))\s*,\s*(#[0-9a-f]{6}|rgba?\([^)]*\))\s*\)$/i.exec(found.trim())
  if (pair) return color(pair[scheme === "light" ? 1 : 2]!)
  return color(found)
}

/** A token's value in the glass block of index.css. */
function glassToken(name: string): string {
  let found: string | undefined
  sheet("index.css").walkRules((rule) => {
    if (!rule.selector.includes('[data-component="ade-shell"][data-theme="glass"]') || rule.parent?.type !== "root") return
    rule.walkDecls(name, (decl) => {
      found ??= decl.value.trim()
    })
  })
  if (found === undefined) throw new Error(`${name} is not declared in the glass block`)
  return found
}

/**
 * The grounds text sits on, per scheme: the five token grounds, the grounds the live measure caught text failing on, and
 * (glass) the brightest the sheet makes. The glass reading ground is the sheet's own formula over a white desktop at
 * the slider's value, with the raised lift on it.
 */
function glassGround(slider: number): Rgb {
  const read = 0.05 + 0.85 * slider ** 0.24
  return over([255, 255, 255, 0.06], over([18, 13, 11, read], [255, 255, 255]))
}
const GROUND_TOKENS = ["--ade-bg", "--ade-sunken", "--ade-surface", "--ade-raised", "--ade-overlay"] as const
const MEASURED: Record<Scheme, string[]> = {
  light: ["#ecccb4", "#dfd7bb", "#e1d9c8", "#e7dfcf", "#f8e6da"],
  dark: ["#48312b", "#422922", "#4f3830", "#2c2725", "#27221f"],
  glass: ["#4f3830", "#48312b", "#36373d", "#313425", "#342f2c", "#383432", "#2c2725", "#27221f"],
}

/** The grounds the tokens make (glass: the reading ground at three slider values, and the overlay, over a white desktop). */
function tokenGrounds(scheme: Scheme): Rgb[] {
  if (scheme === "glass") {
    // The default slider (75%) and above, like text-contrast.test.ts: below 20% the settings panel says the glass is not for reading.
    return [glassGround(0.75), glassGround(1), over(color(glassToken("--ade-overlay")), [255, 255, 255])]
  }
  return GROUND_TOKENS.map((name) => rgb(token(name, scheme)))
}

/** The token grounds plus the ones the live measure named. */
function grounds(scheme: Scheme): Rgb[] {
  return scheme === "glass" ? [...MEASURED.glass.map(hex), ...tokenGrounds(scheme)] : [...tokenGrounds(scheme), ...MEASURED[scheme].map(hex)]
}

/** `grounds` plus the `--ade-accent-soft` wash over each token ground (a chip or a badge drawn in the accent). */
function groundsWithSoft(scheme: Scheme): Rgb[] {
  const soft = token("--ade-accent-soft", scheme === "light" ? "light" : "dark")
  return [...grounds(scheme), ...tokenGrounds(scheme).map((ground) => over(soft, ground))]
}

/** The grounds a field's edge is drawn against: the page's own, the sampled ones the report named, and the glass extremes. */
function fieldGrounds(scheme: Scheme): Rgb[] {
  if (scheme === "glass") {
    return ["#27221f", "#2c2725", "#383432", "#241c18"].map(hex).concat([glassGround(0.5), glassGround(0.75), glassGround(1)])
  }
  const sampled = scheme === "light" ? ["#f8f0dc", "#f4e8d8", "#f4ecd8"] : ["#181410", "#201c18", "#181010"]
  return [...GROUND_TOKENS.map((name) => rgb(token(name, scheme))), ...sampled.map(hex)]
}

const worst = (text: Rgb, among: Rgb[]) => Math.min(...among.map((ground) => ratio(text, ground)))

// ── 1. tomato as text ─────────────────────────────────────────────────────────

describe("the accent as text has its own token (AA on every ground it sits on)", () => {
  const text = (scheme: Scheme): Rgb =>
    scheme === "glass" ? hex(glassToken("--ade-accent-text")) : rgb(token("--ade-accent-text", scheme))

  for (const scheme of ["light", "dark", "glass"] as const) {
    test(`${scheme}: --ade-accent-text is 4.5:1 or more on every ground, plain and under the accent wash`, () => {
      const value = worst(text(scheme), groundsWithSoft(scheme))
      expect([scheme, value >= 4.5, value.toFixed(2)]).toEqual([scheme, true, value.toFixed(2)])
    })
  }

  test("the accent as a fill stays the brand's tomato", () => {
    expect(read("index.css")).toContain("--ade-accent: light-dark(#b83321, #e86e48);")
  })

  /** Marks painted with `currentColor`: the filled N of the update dialog and the pot in the voice panel's header. */
  const MARKS = ['[data-slot="update-dialog-mark"]', '[data-slot="header-mark"]']

  test("the marks that are fills stay on the brand's tomato", () => {
    const colorOf = (file: string, selector: string, root = src) => {
      let value: string | undefined
      postcss.parse(readFileSync(join(root, file), "utf-8")).walkRules((rule) => {
        if (!rule.selector.includes(selector)) return
        rule.walkDecls("color", (decl) => {
          value = decl.value
        })
      })
      return value
    }
    expect(colorOf("index.css", MARKS[0]!)).toBe("var(--ade-accent)")
    expect(colorOf("ui/voice-settings.css", MARKS[1]!, voice)).toBe("var(--ade-accent)")
  })

  test("no stylesheet sets `color` to the accent itself: text reads --ade-accent-text", () => {
    const offenders: string[] = []
    for (const root of [src, voice]) {
      for (const entry of new Bun.Glob("**/*.css").scanSync(root)) {
        const file = join(root, entry)
        postcss.parse(readFileSync(file, "utf-8")).walkDecls("color", (decl) => {
          // A mark drawn in `currentColor` is a fill, not words: it keeps the brand's tomato (MARKS below).
          if (decl.parent && "selector" in decl.parent && MARKS.some((mark) => decl.parent && "selector" in decl.parent && decl.parent.selector.includes(mark))) return
          if (/^var\(--ade-accent(-strong)?\s*[,)]/.test(decl.value.trim()))
            offenders.push(`${entry.replace(/\\/g, "/")}:${decl.source?.start?.line} ${decl.parent && "selector" in decl.parent ? decl.parent.selector : ""}`)
        })
      }
    }
    expect(offenders).toEqual([])
  })

  test("the words the live measure caught are on the token", () => {
    const rule = (file: string, selector: string, root = src) => {
      let color: string | undefined
      postcss.parse(readFileSync(join(root, file), "utf-8")).walkRules(selector, (r) => {
        r.walkDecls("color", (d) => {
          color = d.value
        })
      })
      return color
    }
    expect(rule("chat/chat.css", '[data-slot="chat-link"]')).toBe("var(--ade-accent-text)")
    expect(rule("session-new/session-new.css", '[data-slot="new-workspace"]')).toBe("var(--ade-accent-text)")
    expect(rule("session-new/session-new.css", '[data-slot="hook-state"][data-on="true"]')).toBe("var(--ade-accent-text)")
    expect(rule("settings/shell.css", '[data-slot="category-button"][data-active="true"]')).toBe("var(--ade-accent-text)")
    expect(rule("ui/voice-settings.css", '[data-component="voice-settings-panel"] [data-slot="link-button"]', voice)).toContain(
      "--ade-accent-text",
    )
    expect(
      rule("ui/voice-settings.css", '[data-component="voice-settings-panel"] [data-slot="mode-card-badge"]', voice),
    ).toContain("--ade-accent-text")
  })
})

// ── 2. the edge of a field ────────────────────────────────────────────────────

describe("a field's edge is the control border (3:1)", () => {
  /** The rules that draw a text field, found by their name; the ones that are not fields are named. */
  // `search-input` is the bare input inside `search-field`, the sidebar's filled field (the user's choice: «un campo pieno
  // invece che contornato»); the border its first rule names is overridden by `border: 0` further down. Its edge is a
  // fill, which waits with the other fills for the user's choice.
  const NOT_A_FIELD = ["ade-search", "search-kind", "design-recipient-wrap", "search-input"]
  const FIELD = /(\binput\b|\bselect\b|textarea|field|search|recipient|-input)/i

  function fieldRules(): Array<{ file: string; selector: string; prop: string; value: string }> {
    const found: Array<{ file: string; selector: string; prop: string; value: string }> = []
    for (const root of [src, voice]) {
      for (const entry of new Bun.Glob("**/*.css").scanSync(root)) {
        postcss.parse(readFileSync(join(root, entry), "utf-8")).walkRules((rule) => {
          const selector = rule.selector.replace(/\s+/g, " ")
          if (!FIELD.test(selector) || NOT_A_FIELD.some((name) => selector.includes(`"${name}"`))) return
          if (/::placeholder|:hover|:active|:disabled|:invalid|aria-invalid/.test(selector)) return
          rule.walkDecls(/^(border|border-color)$/, (decl) => {
            found.push({ file: `${root === voice ? "voice/" : ""}${entry.replace(/\\/g, "/")}`, selector, prop: decl.prop, value: decl.value })
          })
        })
      }
    }
    return found
  }

  test("every field's resting border is --ade-control-border, and focus never makes it weaker", () => {
    const rules = fieldRules()
    // Rule 22: a scan that found nothing proves nothing.
    expect([rules.length, rules.length > 15]).toEqual([rules.length, true])
    // At rest a field's edge is the control border, not a step of the ramp (a `0`, `transparent`, a state colour or
    // another world's own token is not the ramp, so it is not looked at); in focus it may be anything but the ramp.
    const ramp = /var\(--ade-border(-subtle|-strong)?[,)]/
    const offenders = rules
      .filter(({ selector, value }) =>
        /:focus/.test(selector) ? ramp.test(value.trim().replace(/^1px solid /, "")) && value.trim().replace(/^1px solid /, "").startsWith("var(--ade-border") : ramp.test(value) && !value.includes("var(--ade-control-border"),
      )
      .map(({ file, selector, prop, value }) => `${file} ${selector} { ${prop}: ${value} }`)
    const onToken = rules.filter(({ selector, value }) => !/:focus/.test(selector) && value.includes("var(--ade-control-border")).length
    expect([onToken, onToken >= 12]).toEqual([onToken, true])
    expect(offenders).toEqual([])
  })

  /**
   * Every <input>, <select> and <textarea> in the .tsx files that carries its own data-slot, found from the markup: a field
   * is a field whatever its slot is called (the name scan above missed five). Checkboxes, ranges and files are not fields.
   */
  function markupSlots(): Map<string, string> {
    const found = new Map<string, string>()
    for (const root of [src, voice]) {
      for (const entry of new Bun.Glob("**/*.tsx").scanSync(root)) {
        if (/\.test\./.test(entry)) continue
        const text = readFileSync(join(root, entry), "utf-8")
        for (const match of text.matchAll(/<(input|select|textarea)\b/g)) {
          const rest = text.slice(match.index! + 1)
          const next = rest.search(/\n\s*<[A-Za-z/]/)
          const tag = rest.slice(0, Math.min(next < 0 ? 900 : next, 900))
          if (/type="(checkbox|radio|range|file|hidden|color)"/.test(tag)) continue
          const slot = /data-slot="([^"]+)"/.exec(tag)?.[1]
          if (slot) found.set(slot, `${root === voice ? "voice/" : ""}${entry.replace(/\\/g, "/")}`)
        }
      }
    }
    return found
  }

  // Named, and each for a reason: the composers are the user's «semplice base nero» (composer-focus.test.ts), the sidebar's
  // search is a filled field, the others draw no edge of their own.
  const ON_THE_RAMP_BY_CHOICE = ["chat-input", "bots-composer-field", "search-input", "recipient-inline"]

  test("every input, select and textarea in the markup draws no edge on the ramp", () => {
    const slots = markupSlots()
    // Rule 22: a scan that found nothing proves nothing.
    expect([slots.size, slots.size > 15]).toEqual([slots.size, true])
    const ramp = /var\(--ade-border(-subtle|-strong)?[,)]/
    const offenders: string[] = []
    for (const root of [src, voice]) {
      for (const entry of new Bun.Glob("**/*.css").scanSync(root)) {
        postcss.parse(readFileSync(join(root, entry), "utf-8")).walkRules((rule) => {
          for (const selector of rule.selectors) {
            const slot = /\[data-slot="([^"]+)"\](?::[a-z-]+(?:\([^)]*\))?)*$/.exec(selector.trim())?.[1]
            if (!slot || !slots.has(slot) || ON_THE_RAMP_BY_CHOICE.includes(slot)) continue
            if (/:hover|:active|:disabled|:invalid|::placeholder/.test(selector)) continue
            rule.walkDecls(/^(border|border-color)$/, (decl) => {
              if (ramp.test(decl.value) && !decl.value.includes("var(--ade-control-border"))
                offenders.push(`${entry.replace(/\\/g, "/")} ${selector.trim()} { ${decl.prop}: ${decl.value} }`)
            })
          }
        })
      }
    }
    expect(offenders).toEqual([])
  })

  test("the named fields are all in the scan", () => {
    const text = fieldRules()
      .filter(({ prop, selector }) => prop === "border" && !/:focus/.test(selector))
      .map(({ selector }) => selector)
      .join("\n")
    for (const name of [
      "agent-input",
      "bots-input",
      "keys-field",
      "ext-search",
      "decisions-recipient",
      "design-recipient",
      'remote-space"] input',
      'voice-settings-panel"] [data-slot="input"]',
      'voice-settings-panel"] [data-slot="select"]',
    ]) {
      expect(text).toContain(name)
    }
  })

  test("glass has its own control border, 3:1 on the grounds the report measured and on the brightest the sheet makes", () => {
    const edge = hex(glassToken("--ade-control-border"))
    const value = worst(edge, fieldGrounds("glass"))
    expect([value >= 3, value.toFixed(2)]).toEqual([true, value.toFixed(2)])
  })

  test("light and dark keep 3:1 on the grounds the report measured", () => {
    for (const scheme of ["light", "dark"] as const) {
      const value = worst(rgb(token("--ade-control-border", scheme)), fieldGrounds(scheme))
      expect([scheme, value >= 3, value.toFixed(2)]).toEqual([scheme, true, value.toFixed(2)])
    }
  })
})

// ── 3. the launcher and the sidebar ───────────────────────────────────────────

describe("the separator between a session's words is readable and not announced", () => {
  test("its colour is the weak text, with no opacity taken off it", () => {
    let color: string | undefined
    let opacity: string | undefined
    sheet("sidebar/sidebar.css").walkRules('[data-slot="agent-card-sep"]', (rule) => {
      rule.walkDecls((decl) => {
        if (decl.prop === "color") color = decl.value
        if (decl.prop === "opacity") opacity = decl.value
      })
    })
    expect(color).toBe("var(--ade-text-weak)")
    expect(opacity).toBeUndefined()
  })

  test("3:1 or more in light, dark and glass, on a selected or tinted card too", () => {
    for (const scheme of ["light", "dark", "glass"] as const) {
      const weak = scheme === "glass" ? hex(glassToken("--ade-text-weak")) : rgb(token("--ade-text-weak", scheme))
      const active = scheme === "glass" ? color(glassToken("--ade-active")) : token("--ade-active", scheme)
      const among = [...grounds(scheme), ...tokenGrounds(scheme).map((ground) => over(active, ground))]
      const value = worst(weak, among)
      expect([scheme, value >= 3, value.toFixed(2)]).toEqual([scheme, true, value.toFixed(2)])
    }
  })

  test("both dots are aria-hidden", () => {
    const tsx = read("sidebar/sidebar.tsx")
    const dots = tsx.match(/<span[^>]*data-slot="agent-card-sep"[^>]*>/g) ?? []
    expect(dots.length).toBe(2)
    for (const dot of dots) expect(dot).toContain('aria-hidden="true"')
  })
})

describe("an agent this machine does not have is dimmer, not faded", () => {
  test("the absent card takes no opacity: its words keep their contrast", () => {
    const offenders: string[] = []
    sheet("session-new/session-new.css").walkRules((rule) => {
      if (!/data-availability="assente"/.test(rule.selector)) return
      rule.walkDecls("opacity", (decl) => {
        // Only the mark may be dimmed: a word at 60% is what the report measured at 2.28:1.
        if (!/new-agent-glyph/.test(rule.selector)) offenders.push(`${rule.selector} { opacity: ${decl.value} }`)
      })
    })
    expect(offenders).toEqual([])
  })

  test("«Da installare» and the label are the soft text on the active wash: AA in every theme", () => {
    const css = sheet("session-new/session-new.css")
    const colorOf = (selector: string) => {
      let value: string | undefined
      css.walkRules(selector, (rule) => {
        rule.walkDecls("color", (decl) => {
          value = decl.value
        })
      })
      return value
    }
    expect(colorOf('[data-slot="new-agent-missing"]')).toBe("var(--ade-text-soft)")
    expect(colorOf('[data-slot="new-agent"][data-availability="assente"] [data-slot="new-agent-label"]')).toBe(
      "var(--ade-text-soft)",
    )
    for (const scheme of ["light", "dark", "glass"] as const) {
      const soft = scheme === "glass" ? hex(glassToken("--ade-text-soft")) : rgb(token("--ade-text-soft", scheme))
      const active = scheme === "glass" ? color(glassToken("--ade-active")) : token("--ade-active", scheme)
      const among = tokenGrounds(scheme).map((ground) => over(active, ground))
      const value = worst(soft, among)
      expect([scheme, value >= 4.5, value.toFixed(2)]).toEqual([scheme, true, value.toFixed(2)])
    }
  })
})

describe("the ⏎ hint on the launch button", () => {
  test("keeps 4.5:1 on the accent fill, in both themes", () => {
    let opacity = Number.NaN
    sheet("session-new/session-new.css").walkRules('[data-slot="new-launch-hint"]', (rule) => {
      rule.walkDecls("opacity", (decl) => {
        opacity = Number(decl.value)
      })
    })
    expect(Number.isNaN(opacity)).toBe(false)
    // The primary Button's fill at rest is --ade-accent and under the pointer --ade-accent-strong (ui/controls.css):
    // the hint is read on both. Glass takes the dark pair.
    const css = read("ui/controls.css")
    expect(css).toContain("--ade-btn-bg-hover: var(--ade-accent-strong);")
    for (const scheme of ["light", "dark"] as const) {
      for (const name of ["--ade-accent", "--ade-accent-strong"]) {
        const fill = rgb(token(name, scheme))
        const ink = token("--ade-accent-fg", scheme)
        const shown = over([ink[0], ink[1], ink[2], opacity], fill)
        const value = ratio(shown, fill)
        expect([scheme, name, value >= 4.5, value.toFixed(2)]).toEqual([scheme, name, true, value.toFixed(2)])
      }
    }
  })
})

// ── 4. marks that carry meaning ───────────────────────────────────────────────

describe("the marks that carry meaning are 3:1 on the tile they sit on", () => {
  test("Claude's logo keeps the vendor's colour: a brand logo is exempt and does not soften (agent-mark.tsx)", () => {
    const tsx = read("session-new/agent-mark.tsx")
    const claude = tsx.slice(tsx.indexOf('"claude-code": (size, colored)'), tsx.indexOf("/*", tsx.indexOf('"claude-code": (size, colored)')))
    expect(claude).toContain('fill={colored() ? "#D97757" : "currentColor"}')
    expect(claude).not.toContain("--cli-color")
    // It does not vanish (2.28 on the active tile, 2.95 on the launch row) and its name is beside it: exempt.
    const light = worst(hex("#d97757"), [hex("#f0d8c8"), hex("#fcf8f0")])
    expect(light).toBeGreaterThan(2)
  })

  test("the terminal's outline is lighter in dark and glass, where #334155 was 1.0 to 1.6:1", () => {
    const tsx = read("session-new/agent-mark.tsx")
    const match = /stroke=\{colored\(\) \? "light-dark\((#[0-9a-fA-F]{6}),\s*(#[0-9a-fA-F]{6})\)" : "currentColor"\}\s*\n\s*stroke-width="1\.4"/.exec(tsx)
    expect(match).not.toBeNull()
    const lightGrounds = ["#fcf8f0", "#fffaf0", "#faf1df", "#f4e7cd"].map(hex)
    const darkGrounds = ["#523b31", "#37302b", "#241c18", "#241e1b", "#3b2823", "#24201f", "#353b25", "#383432", "#333823"].map(hex)
    const light = worst(hex(match![1]!), lightGrounds)
    const dark = worst(hex(match![2]!), darkGrounds)
    expect([light >= 3, light.toFixed(2)]).toEqual([true, light.toFixed(2)])
    expect([dark >= 3, dark.toFixed(2)]).toEqual([true, dark.toFixed(2)])
  })

  test("the orb's lit parts read --ade-on-ink first: in glass --ade-bg is transparent and the mark vanished", () => {
    const css = readFileSync(join(voice, "ui", "orb-mark.css"), "utf-8")
    expect(css).toMatch(/--orb-lit:\s*var\(--ade-on-ink,\s*var\(--ade-bg,\s*#fff\)\)/)
    expect(glassToken("--ade-bg")).toBe("transparent")
    expect(glassToken("--ade-on-ink")).toBe("var(--ade-glass-ground)")
  })
})

// ── 5. the one focus ring under 3:1 ───────────────────────────────────────────

describe("the resize grip's focus ring in glass", () => {
  test("carries a dark halo, so the ring is read against the halo and not against the desktop", () => {
    let value: string | undefined
    sheet("index.css").walkRules((rule) => {
      if (rule.selector.replace(/\s+/g, " ") !== '[data-component="ade-shell"][data-theme="glass"] [data-slot="tile-resize"]:focus-visible') return
      rule.walkDecls("box-shadow", (decl) => {
        value = decl.value.trim()
      })
    })
    expect(value).toBeDefined()
    expect(value).toMatch(/^var\(--ade-focus-ring\),\s*0 0 0 3px var\(--ade-glass-ground\)$/)
    // The ring is the glass weak text; the halo is the glass ground. That pair is 3:1 whatever the desktop is.
    const ring = hex(glassToken("--ade-text-weak"))
    const halo = hex(read("index.css").match(/--ade-glass-ground:\s*(#[0-9a-fA-F]{6});/)![1]!)
    expect(ratio(ring, halo)).toBeGreaterThanOrEqual(3)
    // And it is needed: on the floor at the default slider over a white desktop the bare ring is under 3:1.
    const floor = over([18, 13, 11, 0.06 + 0.34 * 0.75], [255, 255, 255])
    expect(ratio(ring, floor)).toBeLessThan(3)
  })
})

// ── 6. a finding that does not hold ───────────────────────────────────────────

describe("the bot form's model chip", () => {
  test("is the text on the page ground in every theme (the white the report saw is the glass value held by a chip that was inside a closed section; not settled, to check live)", () => {
    let color: string | undefined
    let background: string | undefined
    sheet("chat/picker.css").walkRules('[data-slot="chip-menu"][data-below] [data-slot="chip"]', (rule) => {
      rule.walkDecls((decl) => {
        if (decl.prop === "color") color = decl.value
        if (decl.prop === "background") background = decl.value
      })
    })
    expect([color, background]).toEqual(["var(--ade-text)", "var(--ade-bg)"])
    for (const scheme of ["light", "dark"] as const) {
      const value = ratio(rgb(token("--ade-text", scheme)), rgb(token("--ade-bg", scheme)))
      expect([scheme, value >= 4.5]).toEqual([scheme, true])
    }
  })
})

// ── 7. the notice strip in glass (live test 3, FAIL 5) ────────────────────────

describe("the notice strip in glass", () => {
  function stripBackground(): string | undefined {
    let value: string | undefined
    sheet("index.css").walkRules((rule) => {
      if (rule.selector.replace(/\s+/g, " ") !== '[data-component="ade-shell"][data-theme="glass"] [data-slot="ade-notice"]') return
      rule.walkDecls("background", (decl) => {
        value = decl.value.replace(/\s+/g, " ").trim()
      })
    })
    return value
  }

  test("sits on the overlay, which ignores the slider, under its own wash: its ground was alpha 40% (2.05:1 on a white desktop)", () => {
    expect(stripBackground()).toBe(
      "linear-gradient(var(--ade-working-bg), var(--ade-working-bg)), var(--ade-overlay)",
    )
  })

  test("white text on it is 4.5:1 or more over the worst desktop, white", () => {
    const wash = token("--ade-working-bg", "dark")
    const ground = (desktop: Rgb) => over(wash, over(color(glassToken("--ade-overlay")), desktop))
    const text = hex(glassToken("--ade-text"))
    for (const desktop of [[255, 255, 255], [0, 0, 0], [128, 128, 128]] as Rgb[]) {
      expect(ratio(text, ground(desktop))).toBeGreaterThanOrEqual(4.5)
    }
  })
})

// ── 8. what shows through a glass sheet (live test 3, FAIL 6) ─────────────────

describe("the sheets and the Impara bar in glass hide what is under them", () => {
  /**
   * The contrast between a pixel of white terminal text and a pixel of its ground, once the overlay is over both: the
   * ground under a terminal's text is the reading ground (18, 13, 11) at the slider's top, over the desktop; white
   * desktop and black desktop bracket it.
   */
  function leaked(): number {
    const overlay = color(glassToken("--ade-overlay"))
    const text = over(overlay, [255, 255, 255])
    const worst = [over([18, 13, 11, 0.89], [255, 255, 255]), over([18, 13, 11, 0.89], [0, 0, 0])]
    return Math.max(...worst.map((ground) => ratio(text, over(overlay, ground))))
  }

  test("the overlay lets through under 1.1:1 of the text below it (at alpha 0.92 it was 1.29 and legible)", () => {
    expect(leaked()).toBeLessThan(1.1)
  })

  test("and it is still a little less than opaque: glass stays glass on the app's frame, the sheets are a floor of their own", () => {
    expect(color(glassToken("--ade-overlay"))[3]).toBeLessThan(1)
  })

  test("the Impara bar sits on the overlay in glass: its buttons were over the world's HUD text", () => {
    let value: string | undefined
    sheet("index.css").walkRules((rule) => {
      if (rule.selector.replace(/\s+/g, " ") !== '[data-component="ade-shell"][data-theme="glass"] [data-slot="learn-progress"]') return
      rule.walkDecls("background", (decl) => {
        value = decl.value.trim()
      })
    })
    expect(value).toBe("var(--ade-overlay)")
  })
})
