import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * Review of ade/testi-resto, UX-16: the «install it from New session» tooltip was shown for every not-installed card,
 * including outside the desktop app, where there is no host and no New session to install from; and it sat on a span
 * the keyboard could not reach, so only a mouse found out where to install.
 */
const source = readFileSync(join(import.meta.dir, "account.tsx"), "utf8")
const css = readFileSync(join(import.meta.dir, "sections.css"), "utf8")

describe("the install hint on a runner's badge (UX-16, review)", () => {
  test("it is shown only for a CLI that is really missing, not when there is no host to ask", () => {
    expect(source.includes('kind() === "not-installed" && state()?.login.state === "out"')).toBe(true)
  })

  test("the badge can be focused and carries its text as its name, so a keyboard or screen reader user gets it", () => {
    const at = source.indexOf('data-slot="provider-badge"')
    const tag = source.slice(at, source.indexOf("</span>", at))
    expect(tag.includes('tabindex="0"')).toBe(true)
    expect(tag.includes('role="note"')).toBe(true)
    expect(tag.includes("aria-label={")).toBe(true)
  })

  test("a focused badge shows the focus ring", () => {
    const rule = css.match(/\[data-slot="provider-badge"\]:focus-visible\s*\{([^}]*)\}/)?.[1] ?? ""
    expect(rule.includes("var(--ade-focus-ring)")).toBe(true)
  })
})
