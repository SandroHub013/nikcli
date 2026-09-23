/**
 * The links in a session: URLs and file paths, made clickable by ADE.
 *
 * xterm's only link provider is its own, for OSC 8, which almost nothing an
 * agent prints uses. A URL or a `file:line` in a session was plain text. This
 * finds them, and turns a buffer row into links xterm can draw and activate.
 *
 * Nothing here opens anything: `activate` hands the link to whoever attached
 * the terminal, and only on a click. A URL written by an agent stays put.
 */
import type { IBufferRange, ILink, Terminal } from "@xterm/xterm"
import { t } from "../i18n"

export interface FoundLink {
  /** Index into the text, inclusive. */
  start: number
  /** Index into the text, exclusive. */
  end: number
  kind: "url" | "file"
  target: string
  line?: number
  column?: number
}

/** What a click on a link asks for. `external` is Ctrl (or Cmd) held. */
export interface LinkRequest {
  kind: "url" | "file"
  target: string
  line?: number
  column?: number
  external: boolean
}

const URL = /https?:\/\/[^\s<>"'\u0000-\u001f\u007f]+/g
// A `:` before the token is refused, so `file:`, `javascript:` and a URL's own
// path never start one; a drive letter is the one colon a path may begin with.
const PATH =
  /(?<![\p{L}\p{N}_.\-~@+/\\:])((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])?[\p{L}\p{N}_.\-~@+]+(?:[\\/][\p{L}\p{N}_.\-~@+]+)*)(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\))?/gu
const OPEN: Record<string, string> = { ")": "(", "]": "[", "}": "{" }

/** Cuts what a sentence adds after a URL: final punctuation, and closers it never opened. */
function trimUrl(url: string): string {
  let end = url.length
  for (;;) {
    const last = url[end - 1]
    if (".,;:!?".includes(last)) {
      end--
      continue
    }
    const open = OPEN[last]
    if (open) {
      const body = url.slice(0, end)
      if (body.split(open).length < body.split(last).length) {
        end--
        continue
      }
    }
    return url.slice(0, end)
  }
}

/** The URLs and file paths in one logical line of text. */
export function findLinks(text: string): FoundLink[] {
  const links: FoundLink[] = []
  for (const match of text.matchAll(URL)) {
    const target = trimUrl(match[0])
    // Only a host: `https://` alone is not somewhere to go.
    if (target.length <= target.indexOf("//") + 2) continue
    links.push({ start: match.index, end: match.index + target.length, kind: "url", target })
  }
  const inUrl = (at: number) => links.some((link) => link.kind === "url" && at >= link.start && at < link.end)

  for (const match of text.matchAll(PATH)) {
    if (inUrl(match.index)) continue
    let path = match[1]
    const suffix = match[0].length - path.length
    const lineText = match[2] ?? match[4]
    const columnText = match[3] ?? match[5]
    // A sentence's full stop is not part of a path it ends on.
    if (!suffix) path = path.replace(/\.+$/, "")
    const separated = /[\\/]/.test(path)
    const extension = /[^\\/.]\.[A-Za-z]{1,8}$/.test(path)
    if (!separated && !extension) continue
    if (!extension && !lineText) continue
    links.push({
      start: match.index,
      end: match.index + (suffix ? match[0].length : path.length),
      kind: "file",
      target: path,
      line: lineText ? Number(lineText) : undefined,
      column: columnText ? Number(columnText) : undefined,
    })
  }
  return links.sort((a, b) => a.start - b.start)
}

/** The part of a buffer `logicalLine` reads: little enough to fake in a test. */
export interface LinkBuffer {
  readonly type: "normal" | "alternate"
  getLine(y: number):
    | {
        readonly isWrapped: boolean
        readonly length: number
        getCell(x: number): { getChars(): string; getWidth(): number } | undefined
      }
    | undefined
}

/**
 * The text a row belongs to, with the cell each character came from.
 *
 * In the normal buffer the rows the pane wrapped are joined, so a URL cut by
 * the pane's width is one link. In the alternate buffer every row is the
 * program's own and stays alone. Rows are 0-based here.
 */
export function logicalLine(buffer: LinkBuffer, row: number): { text: string; cells: Array<{ x: number; y: number }> } {
  let first = row
  let last = row
  if (buffer.type === "normal") {
    while (first > 0 && buffer.getLine(first)?.isWrapped) first--
    while (buffer.getLine(last + 1)?.isWrapped) last++
  }
  let text = ""
  const cells: Array<{ x: number; y: number }> = []
  for (let y = first; y <= last; y++) {
    const line = buffer.getLine(y)
    if (!line) break
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x)
      if (!cell || cell.getWidth() === 0) continue
      const chars = cell.getChars() || " "
      for (let i = 0; i < chars.length; i++) cells.push({ x, y })
      text += chars
    }
  }
  return { text, cells }
}

/** What the pointer says over a link, before anyone clicks. */
export function linkTitle(link: FoundLink): string {
  if (link.kind === "url") return t("pane.link.url")
  return link.line ? t("pane.link.fileAt", link.line) : t("pane.link.file")
}

/**
 * The links on a buffer row, as xterm wants them: 1-based, ends inclusive.
 *
 * `row` is the 1-based line xterm asks about. A link that spans rows is given
 * for each row it touches.
 */
export function linksOnRow(
  buffer: LinkBuffer,
  row: number,
  onLink: (request: LinkRequest) => void,
  setTitle: (title: string | undefined) => void,
): ILink[] {
  const y0 = row - 1
  const { text, cells } = logicalLine(buffer, y0)
  const links: ILink[] = []
  for (const found of findLinks(text)) {
    const from = cells[found.start]
    const to = cells[found.end - 1]
    if (!from || !to || from.y > y0 || to.y < y0) continue
    const range: IBufferRange = { start: { x: from.x + 1, y: from.y + 1 }, end: { x: to.x + 1, y: to.y + 1 } }
    const title = linkTitle(found)
    links.push({
      range,
      text: text.slice(found.start, found.end),
      decorations: { underline: true, pointerCursor: true },
      hover: () => setTitle(title),
      leave: () => setTitle(undefined),
      activate: (event: MouseEvent) =>
        onLink({
          kind: found.kind,
          target: found.target,
          line: found.line,
          column: found.column,
          external: Boolean(event.ctrlKey || event.metaKey),
        }),
    })
  }
  return links
}

/** Registers ADE's link provider on a terminal; returns what removes it. */
export function registerLinks(terminal: Terminal, element: HTMLElement, onLink: (request: LinkRequest) => void): () => void {
  const setTitle = (title: string | undefined) => {
    if (title) element.title = title
    else element.removeAttribute("title")
  }
  const provider = terminal.registerLinkProvider({
    provideLinks: (row, callback) => {
      const links = linksOnRow(terminal.buffer.active as LinkBuffer, row, onLink, setTitle)
      callback(links.length ? links : undefined)
    },
  })
  return () => {
    provider.dispose()
    setTitle(undefined)
  }
}
