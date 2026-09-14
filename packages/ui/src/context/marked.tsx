import { marked } from "marked"
import markedShiki from "marked-shiki"
import type { BundledLanguage } from "shiki"
import { createSimpleContext } from "./helper"



/**
 * The highlighter drags in @pierre/diffs, the shiki core and its TextMate engine
 * — ~450 kB that only matters once a code block is actually rendered. Everything
 * below the first `await` is fetched on demand and shared across callers.
 */
type Highlighter = Awaited<ReturnType<(typeof import("@pierre/diffs"))["getSharedHighlighter"]>>

let highlighterPromise: Promise<{ highlighter: Highlighter; isBundled: (lang: string) => boolean }> | undefined

function loadHighlighter() {
  // A rejected promise must not be cached: a chunk that fails to load once —
  // stale build after a deploy, a dropped connection — would otherwise make every
  // later parse rethrow the same failure. `Markdown` renders through a resource,
  // so that turns one bad fetch into every message with a code fence throwing for
  // the rest of the session. Clearing the slot lets the next attempt retry.
  highlighterPromise ??= (async () => {
    const [diffs, shiki, theme] = await Promise.all([
      import("@pierre/diffs"),
      import("shiki"),
      import("../pierre/theme"),
    ])
    theme.registerNikcliTheme()
    const highlighter = await diffs.getSharedHighlighter({ themes: ["Nikcli"], langs: [] })
    return { highlighter, isBundled: (lang: string) => lang in shiki.bundledLanguages }
  })().catch((error) => {
    highlighterPromise = undefined
    throw error
  })
  return highlighterPromise
}

/**
 * Highlighted code blocks, keyed by language and source.
 *
 * A streaming message is re-parsed on every throttled tick, and each parse used
 * to re-highlight every block in it from scratch — including blocks that
 * finished long ago and cannot change. Measured over a 40-tick message that was
 * 2.0s of main-thread work, growing with message length, when only the block
 * still being written actually differs between ticks.
 */
const HIGHLIGHT_CACHE = new Map<string, string>()
const HIGHLIGHT_CACHE_MAX = 400

const highlightKey = (code: string, lang: string | undefined) => `${lang ?? ""}\u0000${code}`

function rememberHighlight(key: string, html: string): string {
  HIGHLIGHT_CACHE.set(key, html)
  if (HIGHLIGHT_CACHE.size > HIGHLIGHT_CACHE_MAX) {
    const oldest = HIGHLIGHT_CACHE.keys().next().value
    if (oldest !== undefined) HIGHLIGHT_CACHE.delete(oldest)
  }
  return html
}

function recallHighlight(key: string): string | undefined {
  const hit = HIGHLIGHT_CACHE.get(key)
  if (hit === undefined) return undefined
  // Refresh recency so the blocks on screen survive eviction.
  HIGHLIGHT_CACHE.delete(key)
  HIGHLIGHT_CACHE.set(key, hit)
  return hit
}

/** Resolve a language name to one shiki can load, then make sure it is loaded. */
async function prepareLanguage(lang: string | undefined) {
  const { highlighter, isBundled } = await loadHighlighter()
  const language = lang && isBundled(lang) ? lang : "text"
  if (!highlighter.getLoadedLanguages().includes(language)) {
    await highlighter.loadLanguage(language as BundledLanguage)
  }
  return { highlighter, language }
}

/**
 * KaTeX is ~600 kB — a sixth of the app's entry chunk — and most sessions never
 * render a formula, so both math paths pull it in on first use instead.
 */
type Katex = (typeof import("katex"))["default"]

let katexModule: Promise<Katex> | undefined
function loadKatex(): Promise<Katex> {
  katexModule ??= import("katex")
    .then((module) => module.default)
    .catch((error) => {
      katexModule = undefined
      throw error
    })
  return katexModule
}

let katexExtension: Promise<void> | undefined
function registerKatexExtension(): Promise<void> {
  katexExtension ??= import("marked-katex-extension")
    .then(({ default: markedKatex }) => {
      marked.use(markedKatex({ throwOnError: false, nonStandard: true }))
    })
    .catch((error) => {
      katexExtension = undefined
      throw error
    })
  return katexExtension
}

/** Cheap pre-check: no `$` in the source means no math for either renderer. */
function mayContainMath(text: string): boolean {
  return text.includes("$")
}

function renderMathInText(text: string, katex: Katex): string {
  let result = text

  // Display math: $$...$$
  const displayMathRegex = /\$\$([\s\S]*?)\$\$/g
  result = result.replace(displayMathRegex, (_, math) => {
    try {
      return katex.renderToString(math, {
        displayMode: true,
        throwOnError: false,
      })
    } catch {
      return `$$${math}$$`
    }
  })

  // Inline math: $...$
  const inlineMathRegex = /(?<!\$)\$(?!\$)((?:[^$\\]|\\.)+?)\$(?!\$)/g
  result = result.replace(inlineMathRegex, (_, math) => {
    try {
      return katex.renderToString(math, {
        displayMode: false,
        throwOnError: false,
      })
    } catch {
      return `$${math}$`
    }
  })

  return result
}

async function renderMathExpressions(html: string): Promise<string> {
  if (!mayContainMath(html)) return html

  // Split on code/pre/kbd tags to avoid processing their contents
  const codeBlockPattern = /(<(?:pre|code|kbd)[^>]*>[\s\S]*?<\/(?:pre|code|kbd)>)/gi
  const parts = html.split(codeBlockPattern)
  const katex = await loadKatex()

  return parts
    .map((part, i) => {
      // Odd indices are the captured code blocks - leave them alone
      if (i % 2 === 1) return part
      // Process math only in non-code parts
      return renderMathInText(part, katex)
    })
    .join("")
}

async function highlightCodeBlocks(html: string): Promise<string> {
  const codeBlockRegex = /<pre><code(?:\s+class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g
  const matches = [...html.matchAll(codeBlockRegex)]
  if (matches.length === 0) return html

  let result = html
  for (const match of matches) {
    const [fullMatch, lang, escapedCode] = match
    const code = escapedCode
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")

    const key = highlightKey(code, lang)
    let highlighted = recallHighlight(key)
    if (highlighted === undefined) {
      const { highlighter, language } = await prepareLanguage(lang)
      highlighted = rememberHighlight(
        key,
        highlighter.codeToHtml(code, { lang: language, theme: "Nikcli", tabindex: false }),
      )
    }
    result = result.replace(fullMatch, () => highlighted)
  }

  return result
}

/**
 * Escape a value being interpolated into a double-quoted HTML attribute.
 *
 * Overriding marked's `link` renderer replaces its escaping along with its
 * markup, so this has to do it again: one quote in an href or a title closes the
 * attribute and everything after it is parsed as markup. Model output reaches
 * here from pages the agent fetched and files it read, so it is attacker text.
 *
 * The `&` case carries the most weight, and not for the obvious reason.
 * `[x](&#x6a;avascript:alert(1))` reaches `safeHref` looking harmless because the
 * scheme is entity-encoded. Writing it out unescaped would let the HTML parser
 * decode it back into `javascript:` inside the attribute; escaping `&` makes the
 * parser hand back the literal text `&#x6a;avascript:`, which is a relative path
 * and inert. Dropping that one line turns three cases in
 * `markdown-link-injection.test.ts` into live handlers.
 */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/** Schemes that execute rather than navigate. */
const UNSAFE_SCHEME = /^[\s\u0000-\u001f]*(?:javascript|vbscript|data|file)\s*:/i

/**
 * The href to render, or undefined when it should not be linked at all.
 *
 * This is the second line of defence, not the first — `escapeAttribute` already
 * makes an entity-encoded scheme inert. What this adds is refusing to render a
 * link at all when the target is plainly executable, so the user is not offered
 * something to click that would never have worked.
 *
 * Decoding happens before the check because a scheme can be spelled with
 * entities or spaced out by control characters. Both decimal and hex forms are
 * handled; leaving one out would not open a hole, but it reads like an oversight.
 */
function safeHref(href: string): string | undefined {
  const decoded = href
    .replace(/&#x([0-9a-f]+);?/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&#(\d+);?/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/[\u0000-\u001f]/g, "")
  if (UNSAFE_SCHEME.test(decoded)) return undefined
  return href
}

export type NativeMarkdownParser = (markdown: string) => Promise<string>

export interface MarkedParser {
  parse(markdown: string): Promise<string>
}

/**
 * Builds the parser the context hands out. Exported so the parsing pipeline —
 * including the deferred KaTeX and shiki paths — can be tested without standing
 * up a component tree.
 */
export function createMarkedParser(options: { nativeParser?: NativeMarkdownParser } = {}): MarkedParser {
  const jsParser = marked.use(
    {
      renderer: {
        link({ href, title, text }) {
          const safe = safeHref(href)
          // Not a link, but the text still belongs on the page.
          if (!safe) return text
          const titleAttr = title ? ` title="${escapeAttribute(title)}"` : ""
          return `<a href="${escapeAttribute(safe)}"${titleAttr} class="external-link" target="_blank" rel="noopener noreferrer">${text}</a>`
        },
      },
    },
    markedShiki({
      async highlight(code, lang) {
        const key = highlightKey(code, lang)
        const cached = recallHighlight(key)
        if (cached !== undefined) return cached
        const { highlighter, language } = await prepareLanguage(lang)
        return rememberHighlight(
          key,
          highlighter.codeToHtml(code, { lang: language, theme: "Nikcli", tabindex: false }),
        )
      },
    }),
  )

  const nativeParser = options.nativeParser
  if (nativeParser) {
    return {
      async parse(markdown: string): Promise<string> {
        const html = await nativeParser(markdown)
        const withMath = await renderMathExpressions(html)
        return highlightCodeBlocks(withMath)
      },
    }
  }

  return {
    async parse(markdown: string): Promise<string> {
      // `marked.use` mutates the singleton `jsParser` builds on, so registering
      // the extension here still applies to this very call.
      if (mayContainMath(markdown)) await registerKatexExtension()
      return jsParser.parse(markdown, { async: true })
    },
  }
}

export const { use: useMarked, provider: MarkedProvider } = createSimpleContext({
  name: "Marked",
  init: (props: { nativeParser?: NativeMarkdownParser }) => createMarkedParser(props),
})
