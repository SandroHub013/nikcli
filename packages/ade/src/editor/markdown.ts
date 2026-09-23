/**
 * A markdown file's preview, as HTML that cannot run anything.
 *
 * `marked` turns the text into HTML and DOMPurify cleans it before it gets
 * near the DOM: no script, no event handler, no `javascript:`, no frame. A
 * README is written by whoever wrote the repository, and a preview that ran
 * its `<img onerror>` would run it inside ADE's own window.
 *
 * Images are the other half. One on the web is removed rather than loaded, so
 * opening a file never reports to anybody that it was opened. One relative to
 * the file is rewritten by `resolve` into a URL ADE serves.
 */
import DOMPurify from "dompurify"
import { marked } from "marked"

/** A relative image's URL, or undefined to drop it. */
export type ResolveImage = (src: string) => string | undefined

/** An address on the web or inline: http, https, protocol-relative or data. */
export function isExternal(src: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src.trim())
}

/**
 * What a picture in the preview loads, or undefined to drop it: a picture on
 * the web or inline never loads, a relative one goes through `resolve`.
 */
export function imageSource(src: string, resolve: ResolveImage): string | undefined {
  if (!src.trim() || isExternal(src)) return undefined
  return resolve(src)
}

let faithful: boolean | undefined

/**
 * Whether DOMPurify really cleans in this DOM.
 *
 * Where it cannot, it hands the input back untouched: that is what it does
 * without a DOM, and under happy-dom it keeps `<script>` and `onerror` as they
 * are. A preview that trusted it there would be raw HTML, so it is asked once,
 * on a sample it must clean.
 */
export function sanitizerWorks(): boolean {
  if (faithful === undefined) {
    try {
      faithful =
        DOMPurify.isSupported &&
        DOMPurify.sanitize('<p>a</p><img src="x" onerror="y"><script>z</script>') === '<p>a</p><img src="x">'
    } catch {
      faithful = false
    }
  }
  return faithful
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

/**
 * What the preview may contain: what `marked` produces, and nothing else.
 *
 * An allowlist, not DOMPurify's html profile. That profile keeps `<form>`,
 * `<button>` and `<area href>`, and a click on a button in a README took ADE's
 * whole window to the page its form named. No `style` either: a
 * `background:url(https://…)` is a tracking pixel the image rule cannot see.
 */
export const ALLOWED_TAGS = [
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "a", "em", "strong", "del", "code", "pre", "blockquote",
  "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td",
  "img", "hr", "br", "span", "div", "details", "summary", "input",
]
export const ALLOWED_ATTR = ["href", "src", "alt", "title", "align", "colspan", "rowspan", "start", "type", "checked", "disabled"]

export function renderMarkdown(text: string, resolve: ResolveImage): string {
  // No cleaning, no HTML: the text as text.
  if (!sanitizerWorks()) return `<pre>${escapeHtml(text)}</pre>`
  const html = marked.parse(text, { async: false, gfm: true }) as string
  // Hooks are global in DOMPurify: added for this call only, then removed.
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    // gfm's task boxes are the one input there is reason for.
    if (node.nodeName === "INPUT" && node.getAttribute("type") !== "checkbox") {
      node.parentNode?.removeChild(node)
      return
    }
    if (node.nodeName !== "IMG") return
    const local = imageSource(node.getAttribute("src") ?? "", resolve)
    node.removeAttribute("srcset")
    if (local) node.setAttribute("src", local)
    else node.parentNode?.removeChild(node)
  })
  try {
    return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOW_DATA_ATTR: false }) as string
  } finally {
    DOMPurify.removeHook("afterSanitizeAttributes")
  }
}

/** What a click on a link in the preview does: the web in ADE's browser, a file in a pane. */
export type LinkTarget = { kind: "web"; url: string } | { kind: "file"; path: string } | { kind: "none" }

/**
 * Decode a URI path without throwing on malformed percent sequences like `100%.png`.
 * When `decodeURI` throws, returns the raw input unchanged.
 */
export function safeDecodeURI(uri: string): string {
  try {
    return decodeURI(uri)
  } catch {
    return uri
  }
}

/**
 * Where a link in a markdown file points.
 *
 * `http(s)` opens in ADE's browser; a relative link is a file next to the
 * markdown; an anchor, a `mailto:` or anything else does nothing.
 */
export function linkTarget(href: string, base: string): LinkTarget {
  const trimmed = href.trim()
  if (/^https?:\/\//i.test(trimmed)) return { kind: "web", url: trimmed }
  if (!trimmed || trimmed.startsWith("#") || isExternal(trimmed)) return { kind: "none" }
  const path = trimmed.split("#")[0].split("?")[0]
  if (!path) return { kind: "none" }
  return { kind: "file", path: joinPath(base, safeDecodeURI(path)) }
}

/**
 * A click in the preview: anything with an `href`, not only `<a>`, goes
 * through `linkTarget` and never navigates the window itself.
 */
export function handlePreviewClick(
  event: Event,
  base: string,
  open: { url?: (url: string) => void; file?: (path: string) => void },
): void {
  const element = (event.target as Element | null)?.closest?.("[href]")
  if (!element) return
  event.preventDefault()
  const target = linkTarget(element.getAttribute("href") ?? "", base)
  if (target.kind === "web") open.url?.(target.url)
  else if (target.kind === "file") open.file?.(target.path)
}

/** The folder a file is in, with its own separator. */
export function folderOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  return cut < 0 ? "" : path.slice(0, cut)
}

/** `relative` read against the folder `base`, with `./` and `../` resolved. */
export function joinPath(base: string, relative: string): string {
  if (/^(?:[A-Za-z]:)?[\\/]/.test(relative)) return relative
  const parts = base.split(/[\\/]/)
  for (const part of relative.split(/[\\/]/)) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (parts.length > 1) parts.pop()
      continue
    }
    parts.push(part)
  }
  return parts.join("/")
}
