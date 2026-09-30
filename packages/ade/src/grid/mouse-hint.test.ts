import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * "Alt+click to the program" never wraps and does not shrink, so in a narrow
 * pane it would push the header's buttons out (audit 0.7.7, MEDIO 18). It is
 * hidden by the header's own collapse order: the hint is a `.tok`, and
 * `.hA .tok` goes at 720px, well before the 420px rule for cost and tokens.
 * Read from the sources, as happy-dom does not cascade container queries.
 */
const dir = import.meta.dir
const pane = readFileSync(join(dir, "pane.tsx"), "utf8")
const css = readFileSync(join(dir, "pane.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")

/** The selectors hidden by each `@container (max-width: Npx)` block. */
function hiddenAt(): { width: number; selectors: string[] }[] {
  const blocks: { width: number; selectors: string[] }[] = []
  for (const block of css.matchAll(/@container \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/g)) {
    const selectors = [...block[2].matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((rule) => /display:\s*none/.test(rule[2]))
      .flatMap((rule) => rule[1].split(",").map((selector) => selector.trim()))
    blocks.push({ width: Number(block[1]), selectors })
  }
  return blocks
}

describe("the mouse hint leaves a narrow pane's header", () => {
  test("it sits in the pill header, as a token", () => {
    const hint = pane.match(/<span class="([^"]*)" data-slot="pane-mouse-hint"/)
    expect(hint?.[1].split(" ")).toContain("tok")
    const header = pane.indexOf('class="pill hA" data-slot="pane-header"')
    expect(header).toBeGreaterThan(-1)
    expect(pane.indexOf('data-slot="pane-mouse-hint"')).toBeGreaterThan(header)
  })

  test("a container query hides it at 420px or wider, with cost and tokens", () => {
    const widest = hiddenAt()
      .filter((block) =>
        block.selectors.some((selector) => selector === ".hA .tok" || selector === '[data-slot="pane-mouse-hint"]'),
      )
      .map((block) => block.width)
    expect(Math.max(0, ...widest)).toBeGreaterThanOrEqual(420)
  })
})

/* Mouse sessions: the program has the clicks now, and the hint says how to select. */
describe("the mouse hint says Shift+drag", () => {
  test("in Italian and in English, with the link's Ctrl+click in the tip", async () => {
    const it = (await import("../i18n/it")).it as Record<string, unknown>
    const en = (await import("../i18n/en")).en as Record<string, unknown>
    expect(it["pane.mouseHint"]).toBe("Maiusc+trascina per selezionare")
    expect(en["pane.mouseHint"]).toBe("Shift+drag to select")
    expect(String(it["pane.mouseHint.tip"])).toContain("Ctrl+clic")
    expect(String(it["pane.mouseHint.tip"])).not.toContain("Alt")
  })
})

/*
 * Verifiche's point 4: at two columns (panes of 591 px) the hint had gone with
 * the tokens, just where Shift+drag is needed. It stays there, short, and goes
 * only with the cost, at 420 px. The cascade is read from the sources.
 */
type Rule = { at: number; width: number; selectors: string[]; display?: string }

function rules(): Rule[] {
  const out: Rule[] = []
  const blocks = [...css.matchAll(/@container \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/g)]
  const read = (text: string, offset: number, width: number) => {
    for (const rule of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      out.push({
        at: offset + rule.index!,
        width,
        selectors: rule[1].split(",").map((selector) => selector.trim()),
        display: rule[2].match(/display:\s*([a-z-]+)/)?.[1],
      })
    }
  }
  let flat = css
  for (const block of blocks) {
    read(block[2], block.index!, Number(block[1]))
    flat = flat.slice(0, block.index!) + " ".repeat(block[0].length) + flat.slice(block.index! + block[0].length)
  }
  read(flat, 0, Infinity)
  return out.sort((a, b) => a.at - b.at)
}

/** The display the last of `selectors` to set one gives, in a pane `width` wide ("" when none sets it). */
function displayAt(width: number, selectors: string[]): string {
  let display = ""
  for (const rule of rules()) {
    if (width > rule.width || !rule.display) continue
    if (rule.selectors.some((selector) => selectors.includes(selector))) display = rule.display
  }
  return display
}

const HINT = [".hA .tok", '.hA [data-slot="pane-mouse-hint"]']
const LONG = ['.hA [data-slot="pane-mouse-hint"] .hint-long']
const SHORT = ['[data-slot="pane-mouse-hint"] .hint-short', '.hA [data-slot="pane-mouse-hint"] .hint-short']

describe("the mouse hint in the grid (Verifiche's point 4)", () => {
  test("the pill carries a long and a short label", () => {
    expect(pane).toContain('<span class="hint-long">{t("pane.mouseHint")}</span>')
    expect(pane).toContain('<span class="hint-short">{t("pane.mouseHint.short")}</span>')
  })

  test("a wide pane shows the long label", () => {
    expect(displayAt(1216, HINT)).not.toBe("none")
    expect(displayAt(1216, LONG)).not.toBe("none")
    expect(displayAt(1216, SHORT)).toBe("none")
  })

  test("two columns (591 px) show the short one", () => {
    expect(displayAt(591, HINT)).not.toBe("none")
    expect(displayAt(591, LONG)).toBe("none")
    expect(displayAt(591, SHORT)).not.toBe("none")
  })

  test("at 420 px it goes, with the cost", () => {
    expect(displayAt(420, HINT)).toBe("none")
    expect(displayAt(300, HINT)).toBe("none")
  })

  test("the short label, in Italian and in English", async () => {
    const it = (await import("../i18n/it")).it as Record<string, unknown>
    const en = (await import("../i18n/en")).en as Record<string, unknown>
    expect(it["pane.mouseHint.short"]).toBe("Maiusc+trascina")
    expect(en["pane.mouseHint.short"]).toBe("Shift+drag")
  })
})
