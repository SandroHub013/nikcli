import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import postcss from "postcss"

/*
 * Opening a settings section moves focus to its heading, and the ring sat
 * flush on the text, with no room on the left (Verifiche,
 * barra-versione-seguito-scatti, point 6). The heading needs padding for the
 * ring to breathe, an equal negative margin so the text does not move, and the
 * radius the other settings rings use.
 */

const sheet = postcss.parse(readFileSync(join(import.meta.dir, "../../../voice/src/ui/voice-settings.css"), "utf-8"))
const TITLE = '[data-component="voice-settings-panel"] [data-slot="section-title"]'

function decls(selector: string) {
  const out: Record<string, string> = {}
  sheet.walkRules((rule) => {
    if (rule.selector !== selector || rule.parent?.type === "atrule") return
    rule.walkDecls((decl) => {
      out[decl.prop] = decl.value
    })
  })
  return out
}

test("the focused section heading keeps a gap between its ring and its text", () => {
  const base = decls(TITLE)
  const [block, inline] = (base.padding ?? "0").split(/\s+/)
  expect(inline ?? block).not.toBe("0")
  expect(base.margin).toBe(`calc(-1 * ${block}) calc(-1 * ${inline ?? block})`)
})

test("its ring is the shared one, with the settings controls' radius", () => {
  const focus = decls(`${TITLE}:focus-visible`)
  expect(focus["box-shadow"]).toBe("var(--ade-focus-ring)")
  expect(focus["border-radius"]).toBe("var(--ade-radius-sm)")
})
