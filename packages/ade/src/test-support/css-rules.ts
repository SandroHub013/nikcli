/**
 * Just enough of the CSS cascade to ask a sheet what it does to an element.
 *
 * Several faults of the session-state work lived between rules, where a test
 * that reads the sheet as text cannot see them: a rule that was written and
 * never applied because a later one of the same weight overrode it, and a
 * collapse rule that hid parts of a card it was never meant for. This reads a
 * sheet into rules (with the `@media` / `@container` they sit in), gives each
 * its specificity, and lets a test ask which rules match a real element and
 * which one wins a property. It is not a browser: no inheritance, no
 * `!important`, no media evaluation (the caller reads `at` and decides).
 */

export interface CssRule {
  selector: string
  body: string
  /** Source order, for ties. */
  order: number
  /** The enclosing at-rules' preludes, outermost first (`@container (max-width: 260px)`). */
  at: string[]
}

function splitSelectors(prelude: string): string[] {
  const out: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < prelude.length; i++) {
    const c = prelude[i]
    if (c === "(" || c === "[") depth++
    else if (c === ")" || c === "]") depth--
    else if (c === "," && depth === 0) {
      out.push(prelude.slice(from, i).trim())
      from = i + 1
    }
  }
  out.push(prelude.slice(from).trim())
  return out.filter(Boolean)
}

function parseBlock(text: string, at: string[], out: CssRule[]): void {
  let i = 0
  while (i < text.length) {
    const open = text.indexOf("{", i)
    if (open < 0) break
    const prelude = text.slice(i, open).trim()
    let depth = 1
    let j = open + 1
    while (j < text.length && depth > 0) {
      if (text[j] === "{") depth++
      else if (text[j] === "}") depth--
      j++
    }
    const body = text.slice(open + 1, j - 1)
    if (prelude.startsWith("@")) {
      if (/^@(media|container|supports|layer)/.test(prelude)) parseBlock(body, [...at, prelude], out)
    } else {
      for (const selector of splitSelectors(prelude)) out.push({ selector, body, order: out.length, at })
    }
    i = j
  }
}

export function parseCss(css: string): CssRule[] {
  const out: CssRule[] = []
  parseBlock(css.replace(/\/\*[\s\S]*?\*\//g, ""), [], out)
  return out
}

/** [ids, classes/attributes/pseudo-classes, elements/pseudo-elements]. `:is` `:not` `:has` count by their argument. */
export function specificity(selector: string): [number, number, number] {
  let rest = selector
  const unwrap = /:(?:is|not|has|where)\(([^()]*)\)/g
  // `:where` weighs nothing; the others weigh their argument, which flattening into the selector gives.
  rest = rest.replace(/:where\([^()]*\)/g, "").replace(unwrap, " $1 ")
  const ids = (rest.match(/#[\w-]+/g) ?? []).length
  rest = rest.replace(/#[\w-]+/g, " ")
  const pseudoElements = (rest.match(/::[\w-]+/g) ?? []).length
  rest = rest.replace(/::[\w-]+/g, " ")
  const classes = (rest.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+/g) ?? []).length
  rest = rest.replace(/\.[\w-]+|\[[^\]]*\]|:[\w-]+(\([^()]*\))?/g, " ")
  const elements = (rest.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length
  return [ids, classes, elements + pseudoElements]
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!
  return 0
}

/** Whether `element` is matched by `selector`; a selector the DOM cannot parse matches nothing. */
export function matches(element: Element, selector: string): boolean {
  try {
    return element.matches(selector)
  } catch {
    return false
  }
}

/** The rules that match `element`, in cascade order (the winner is last). Pseudo-element rules are left out. */
export function rulesFor(rules: CssRule[], element: Element): CssRule[] {
  return rules
    .filter((rule) => !/::/.test(rule.selector) && matches(element, rule.selector))
    .sort((a, b) => compare(specificity(a.selector), specificity(b.selector)) || a.order - b.order)
}

/** The rule that sets `property` on `element` and wins, outside any at-rule (the base case). */
export function winner(rules: CssRule[], element: Element, property: string): CssRule | undefined {
  const declares = new RegExp(`(^|[;\\s])${property}\\s*:`)
  return rulesFor(
    rules.filter((rule) => rule.at.length === 0),
    element,
  )
    .filter((rule) => declares.test(rule.body))
    .at(-1)
}
