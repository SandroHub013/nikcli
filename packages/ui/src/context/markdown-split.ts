/**
 * Where a streaming markdown document stops changing.
 *
 * A transcript re-parses the whole message on every tick, so the cost of one
 * tick grows with the message and the cost of a message grows with its square.
 * Measured on a 60-tick answer: 15ms per tick for plain prose, 22ms with code
 * blocks, and it is the prose that dominates — the highlight cache cannot help
 * there because there is nothing to highlight.
 *
 * Markdown is block-structured, so most of a growing document is already
 * settled: only the block currently being written can still change. This finds
 * the point up to which that is true, so the caller can parse each segment once
 * instead of once per tick.
 *
 * The contract is strict and the fallback is total: `parse(a) + parse(b)` must
 * be byte-identical to `parse(a + b)`. Anything this function is not certain
 * about returns 0, meaning "no safe split, parse the whole thing". The
 * equivalence is pinned by a test that walks every prefix of a corpus of the
 * constructs that break naive splitting.
 */

/**
 * Link reference definitions resolve across the whole document — a definition
 * written later changes how an earlier paragraph renders — so a document that
 * contains one cannot be split at all.
 */
const LINK_DEFINITION = /^[ 	]*\[[^\]]*\]:/

/** A line that continues a construct started before the blank line above it. */
const CONTINUES_PREVIOUS =
  /^ {0,3}(?:[-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|>|\||=+[ \t]*$|-+[ \t]*$|:)/

/** Fence openers, with the run length so a shorter run inside does not close it. */
const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/

/**
 * CommonMark 4.6 HTML block type 1. These end at their closing tag or at the end
 * of the input — a blank line does not close them, contrary to what this file
 * used to claim. Splitting inside one is permanent, not a flicker: the prefix
 * HTML is cached and only the tail is ever re-rendered, so `<script>` source that
 * should render as nothing becomes visible page text, and `<textarea>` content
 * that should stay inert escapes into live markup.
 */
const RAW_TEXT_OPEN = /^ {0,3}<(pre|script|style|textarea)(?=[\s/>]|$)/i

/** Types 2-5: processing instruction, declaration, CDATA. Also blank-line-proof. */
const DECLARATION_OPEN = /^ {0,3}<(\?|!\[CDATA\[|![A-Za-z])/

/**
 * Block-level containers that may wrap several blocks.
 *
 * The parse composes across these — type 6 blocks do end at a blank line — but
 * the *sanitiser* does not: DOMPurify balances each fragment on its own, so an
 * unclosed container in the prefix gets auto-closed and everything after the
 * blank line falls outside it. Measured at 19 of 250 prefixes where the parse
 * was byte-identical. Refusing the boundary while one is open is the cheap fix.
 */
const CONTAINER_TAG =
  /<(\/?)(?:div|section|article|aside|details|figure|figcaption|blockquote|table|thead|tbody|tfoot|tr|td|th|ul|ol|li|dl|dd|dt|main|nav|header|footer|form|fieldset)(?=[\s/>])/gi

function isBlank(line: string): boolean {
  return line.trim().length === 0
}

/**
 * The index one past the last character of the settled prefix, or 0 when the
 * document has no safe split point.
 */
export function stableBoundary(text: string): number {
  if (text.length === 0) return 0

  const lines = text.split("\n")
  let offset = 0
  let boundary = 0
  let fence: { marker: string; length: number } | undefined
  // Two constructs that a blank line does not end, and that the fence machinery
  // above does not cover. Both are tracked rather than pattern-matched on the
  // following line, because what matters is whether one is still *open* here.
  let inComment = false
  let openDisplayMath = false
  // The raw-text tag currently open (`pre`, `script`, `style`, `textarea`), a
  // declaration or CDATA section still running, and how many block containers
  // are unclosed. None of the three is ended by a blank line.
  let rawText: string | undefined
  let inDeclaration = false
  let containerDepth = 0

  for (let index = 0; index < lines.length; index++) {
    // Splitting on the newline leaves the CR of a CRLF document at the end of
    // every line, and `.` in the fence pattern does not match CR — so under CRLF no fence
    // was ever recognised and blank lines *inside* code blocks were taken as
    // boundaries. Match on the stripped line, advance by the raw one.
    const raw = lines[index]!
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    const next = offset + raw.length + 1

    if (rawText) {
      if (new RegExp(`</${rawText}(?=[\s>])|</${rawText}$`, "i").test(line)) rawText = undefined
      offset = next
      continue
    }

    if (inDeclaration) {
      if (line.includes(">")) inDeclaration = false
      offset = next
      continue
    }

    if (fence) {
      const close = FENCE.exec(line)
      if (close && close[2]![0] === fence.marker && close[2]!.length >= fence.length && close[3]!.trim() === "") {
        fence = undefined
      }
      offset = next
      continue
    }

    // One definition anywhere disables splitting for the whole document.
    if (LINK_DEFINITION.test(line)) return 0

    // An HTML comment runs to `-->` or to the end of the input — a blank line
    // does not close it, so text after one is comment content in the whole
    // document and a paragraph in the split. This is the streaming case that
    // matters: a model writes `<!--` and the very next tick is a blank line.
    // (Raw-text blocks and declarations are handled above, before this point.)
    let cursor = 0
    while (cursor < line.length) {
      if (inComment) {
        const close = line.indexOf("-->", cursor)
        if (close === -1) break
        inComment = false
        cursor = close + 3
        continue
      }
      const open = line.indexOf("<!--", cursor)
      if (open === -1) break
      inComment = true
      cursor = open + 4
    }
    if (inComment) {
      offset = next
      continue
    }

    // `marked-katex-extension` pairs a `$$` opener with its closer across blank
    // lines, so a boundary between them turns one formula into two paragraphs —
    // and, worse, can promote the tail into a formula the whole document never
    // rendered. An odd count so far means we are inside one.
    for (const _ of line.matchAll(/\$\$/g)) openDisplayMath = !openDisplayMath
    if (openDisplayMath) {
      offset = next
      continue
    }

    const open = FENCE.exec(line)
    if (open) {
      fence = { marker: open[2]![0]!, length: open[2]!.length }
      offset = next
      continue
    }

    const rawOpen = RAW_TEXT_OPEN.exec(line)
    if (rawOpen) {
      const tag = rawOpen[1]!.toLowerCase()
      // A block opened and closed on one line never puts us inside anything.
      if (!new RegExp(`</${tag}(?=[\s>])|</${tag}$`, "i").test(line)) {
        rawText = tag
        offset = next
        continue
      }
    }

    if (DECLARATION_OPEN.test(line) && !line.includes(">")) {
      inDeclaration = true
      offset = next
      continue
    }

    for (const match of line.matchAll(CONTAINER_TAG)) {
      containerDepth += match[1] === "/" ? -1 : 1
    }
    // Stray closers must not drive the count negative and re-enable splitting.
    if (containerDepth < 0) containerDepth = 0

    if (!isBlank(line)) {
      offset = next
      continue
    }

    // An unclosed block container makes this blank line unusable even though the
    // *parse* would compose across it. The sanitiser balances each fragment on
    // its own, so the prefix gets an auto-inserted closing tag and every block
    // after the blank line lands outside the container it belongs to.
    if (containerDepth > 0) {
      offset = next
      continue
    }

    // A blank line ends the block above it. It is a safe boundary only if what
    // follows starts something new rather than resuming what came before: a
    // list stays one list across a blank line, a table keeps accepting rows,
    // and `===` under a paragraph turns it into a heading.
    let lookahead = index + 1
    while (lookahead < lines.length && isBlank(lines[lookahead]!)) lookahead++
    if (lookahead >= lines.length) {
      // Only blank lines remain: everything before them is settled, but the
      // trailing blanks belong to the tail, since the next chunk continues there.
      offset = next
      continue
    }

    const following = lines[lookahead]!
    // Any leading whitespace disqualifies the line. Four spaces or a tab is an
    // indented code block, which a blank line does not end. Fewer than four is
    // subtler, and is what this used to miss: a list item's continuation
    // paragraph is indented to the item's content column, so
    //
    //   - first
    //
    //     still first item
    //
    // splits into two lists when the boundary is taken at that blank line, and
    // the second renders as a new list rather than the same item continuing.
    if (/^[ \t]/.test(following)) {
      offset = next
      continue
    }
    if (following.trimStart().startsWith("<")) {
      offset = next
      continue
    }
    if (CONTINUES_PREVIOUS.test(following)) {
      offset = next
      continue
    }

    boundary = next
    offset = next
  }

  // An unterminated fence needs no special case: no boundary is ever recorded
  // from inside one, so the last one stands from before the fence opened.
  return boundary
}

/**
 * The settled part of a document, already rendered.
 *
 * `text` is kept verbatim rather than hashed because the check it serves is
 * "does the new text still begin with what we rendered" — a hash answers
 * equality, not prefix-hood, and an edit that rewrites history has to invalidate.
 */
export type StablePrefix = {
  boundary: number
  text: string
  html: string
}

/**
 * Render a growing document without redoing the part that already settled.
 *
 * As the boundary advances, the newly settled span is rendered and appended, and
 * only the unsettled tail is re-rendered per tick.
 *
 * This is NOT linear, and an earlier version of this comment claimed it was.
 * Measured on a realistic 291-character answer — numbered steps, a fence, list
 * continuations — it re-parsed 20,662 characters against 42,486 for the naive
 * approach: a ratio of 0.486. Still quadratic, with a smaller constant. It stays
 * quadratic because the tail is re-parsed on every tick and the boundary only
 * advances when a blank line lands in a splittable position, which in prose-heavy
 * output is rarely.
 *
 * `stableBoundary` is also not monotonic: "2" at one length is a paragraph and
 * "2. " at the next is a list, which moves the boundary backwards. The
 * `cached.boundary <= boundary` guard below turns that into a full re-render of
 * the prefix, which is what keeps those documents correct — load-bearing, and
 * previously undocumented.
 *
 * `render` must be block-composable — the caller's parse and sanitize both are,
 * because every segment is a whole number of markdown blocks.
 */
export async function renderIncremental(input: {
  text: string
  cached: StablePrefix | undefined
  render: (markdown: string) => Promise<string>
}): Promise<{ html: string; prefix: StablePrefix | undefined }> {
  const boundary = stableBoundary(input.text)

  // No safe split — a link reference definition appeared, or the whole document
  // is still one unfinished block. Anything cached is now unusable.
  if (boundary === 0) {
    return { html: await input.render(input.text), prefix: undefined }
  }

  const cached = input.cached
  const reusable =
    cached !== undefined &&
    cached.boundary <= boundary &&
    // The stream only appends; anything else (a rewind, a different message
    // reusing the key) means what we rendered is no longer this document.
    input.text.startsWith(cached.text)

  let prefix: StablePrefix
  if (reusable) {
    const segment = input.text.slice(cached.boundary, boundary)
    prefix = segment
      ? { boundary, text: input.text.slice(0, boundary), html: cached.html + (await input.render(segment)) }
      : cached
  } else {
    const text = input.text.slice(0, boundary)
    prefix = { boundary, text, html: await input.render(text) }
  }

  const tail = input.text.slice(boundary)
  return { html: tail ? prefix.html + (await input.render(tail)) : prefix.html, prefix }
}
