/**
 * Source text as a lint reads it, whatever prettier did to its layout.
 *
 * The release formats the whole repository with prettier, and since the merge
 * of upstream so does ADE (`prettier --write packages/ade packages/voice`). A
 * lint that looked for `createEffect(on(() => props.src, …))` on one line found
 * it on four; one that listed a CSS rule's selectors found one of them broken
 * in two. The code had not changed, only where its lines end.
 */

/** Every run of whitespace made one space: for prose, selectors and CSS. */
export function oneSpace(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/**
 * Code without its layout: no whitespace at all, and no trailing comma before
 * a closing bracket, which prettier adds when it breaks a list over lines.
 * Compare two of these, never one of these with raw source.
 */
/**
 * Each call to `name` in `source`, from the name to its closing parenthesis,
 * without layout (`codeOf`). A lint that read a call off one line found half
 * of it once prettier had spread its arguments over several.
 */
export function callsTo(source: string, name: string): string[] {
  const calls: string[] = []
  for (const match of source.matchAll(new RegExp(`(?<![\\w$])${name}\\(`, "g"))) {
    const end = closingParen(source, match.index + match[0].length - 1)
    if (end > 0) calls.push(codeOf(source.slice(match.index, end + 1)))
  }
  return calls
}

/** Where the parenthesis at `open` closes, strings skipped; -1 if it does not. */
function closingParen(text: string, open: number): number {
  let depth = 0
  for (let at = open; at < text.length; at++) {
    const char = text[at]
    if (char === '"' || char === "'" || char === "`") {
      for (at++; at < text.length && text[at] !== char; at++) if (text[at] === "\\") at++
    } else if (char === "(") depth++
    else if (char === ")" && --depth === 0) return at
  }
  return -1
}

export function codeOf(text: string): string {
  return text
    .replace(/\s+/g, "")
    .replace(/,([)\]}>])/g, "$1")
    .replace(/,$/, "")
}
