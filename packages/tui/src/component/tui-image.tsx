import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch, untrack } from "solid-js"
import { BoxRenderable, RGBA, ScrollBoxRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import {
  applyLiveCapabilities,
  chooseInlineImageRenderer,
  detectCapabilities,
  encodeKittyVirtual,
  encodeAdeImage,
  kittyIdColor,
  kittyPlaceholderGrid,
  pickDecoder,
  renderImage,
  resize,
  type LiveCapabilities,
  type InlineImageRenderer,
  type Decoder,
} from "@ragu/tui-image"
import { cellSize } from "@tui/util/browser-frames"
import { fitOverlayCells, registerNativeOverlay, type CellMetrics, type OverlayRect } from "@tui/util/native-overlay"
import { useTheme } from "@tui/context/theme"
import { createPromiseCache } from "@tui/util/lru-cache"
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useCommandDialog } from "@tui/component/dialog-command"
import { useKeybind } from "@tui/context/keybind"
import { localImagePath, openFullResolutionImage, readImageSource } from "@tui/util/image-open"
import {
  IMAGE_LOADING,
  IMAGE_OPENED,
  IMAGE_OPENING,
  imageCaption,
  imageOpenFailure,
} from "@tui/util/image-caption"

/**
 * Image preview in the scrolling message list.
 *
 * Kitty / Ghostty use grid-native virtual placements. ADE uses OSC 1337
 * after the frame, only within the chat viewport, with half-block cells
 * underneath for partial visibility and failed native output.
 */
export { registerNativeOverlay } from "@tui/util/native-overlay"
export type { NativeOverlay } from "@tui/util/native-overlay"

const MAX_PREVIEW_COLUMNS = 120
const MAX_PREVIEW_FALLBACK_ROWS = 36
const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|bmp|tiff?)(?:$|[?#])/i
const GITHUB_ATTACHMENT = new RegExp("^https://github\\.com/user-attachments/assets/", "i")
const TRANSPARENT = RGBA.fromInts(0, 0, 0, 0)

function cleanPreviewUrl(value: string) {
  return value
    .trim()
    .replace(/^<|>$/g, "")
    .replace(/[),.;:!?]+$/, "")
}

function hostForUrl(value: string) {
  if (value.startsWith("data:image/")) return "attached image"
  if (localImagePath(value)) return "local file"
  try {
    const url = new URL(value)
    if (url.protocol === "file:") return "local file"
    return url.hostname.replace(/^www\./, "") || value
  } catch {
    return value
  }
}

function isSupportedSource(value: string) {
  if (value.startsWith("data:image/")) return true
  try {
    if (localImagePath(value)) return true
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "file:"
  } catch {
    return false
  }
}

function isImageCandidate(value: string, explicit: boolean) {
  if (!isSupportedSource(value)) return false
  if (explicit) return true
  if (IMAGE_EXTENSIONS.test(value)) return true
  return GITHUB_ATTACHMENT.test(value)
}

export function extractTuiImageUrls(text: string, limit = 2) {
  const urls: string[] = []
  const seen = new Set<string>()
  const add = (value: string, explicit: boolean) => {
    const url = cleanPreviewUrl(value)
    if (!url || seen.has(url)) return
    if (!isImageCandidate(url, explicit)) return
    seen.add(url)
    urls.push(url)
  }

  for (const match of text.matchAll(/!\[[^\]]*\]\((?:<([^>]+)>|([^)]+?))(?:\s+["'][^"']*["'])?\)/g)) {
    add(match[1] ?? match[2] ?? "", true)
    if (urls.length >= limit) return urls
  }
  for (const match of text.matchAll(/(?:https?:\/\/|file:\/\/)[^\s<>()\]]+/g)) {
    add(match[0], false)
    if (urls.length >= limit) return urls
  }
  // Absolute paths, Unix (`/x.png`) or Windows (`C:\x.png`, `C:/x.png`).
  for (const match of text.matchAll(/["']((?:\/|[A-Za-z]:[\\/])[^"']+\.(?:png|jpe?g|gif|webp|bmp|tiff?))["']/gi)) {
    add(match[1] ?? "", false)
    if (urls.length >= limit) return urls
  }
  for (const match of text.matchAll(
    /(?:^|\s)((?:\/|[A-Za-z]:[\\/])[\w~./\\%+-]+\.(?:png|jpe?g|gif|webp|bmp|tiff?))(?:$|\s)/gi,
  )) {
    add(match[1] ?? "", false)
    if (urls.length >= limit) return urls
  }
  return urls
}

type Cell = { char: string; fg: RGBA; bg: RGBA }

export type TuiImageData = {
  url: string
  host: string
  width: number
  height: number
  columns: number
  rows: Cell[][]
  /**
   * Kitty virtual-placement transmission (`a=T,U=1,q=2…`). Drawless by
   * construction, so writing it to stdout is safe inside the TUI; written
   * once per cache entry (see `transmitted`).
   */
  nativeBytes?: Uint8Array | string
  /** Whether `nativeBytes` has already been written to the terminal. */
  transmitted?: boolean
  /** Placeholder cell rows the terminal composites the image over. */
  placeholder?: { rows: string[]; fg: RGBA }
  renderer: InlineImageRenderer
  overlay?: { bytes: string; rows: number }
}

export interface TuiImageWriter {
  (bytes: string | Uint8Array): void
}

/**
 * Default writer — writes to `process.stdout`. Only ever used for drawless
 * kitty transmissions; kept injectable so the component can be unit-tested
 * without a live renderer.
 */
const defaultWriter: TuiImageWriter = (bytes) => {
  if (typeof process === "undefined" || !process.stdout) return
  try {
    if (typeof bytes === "string") {
      process.stdout.write(bytes)
    } else {
      process.stdout.write(Buffer.from(bytes))
    }
  } catch {
    // non-fatal
  }
}

// Virtual-placement image ids are per terminal session; offsetting by pid
// keeps concurrent / successive ragu processes from overwriting each
// other's images in the same terminal.
let placeholderIdCounter = 0
const placeholderIdBase = (((typeof process !== "undefined" ? process.pid : 0) ?? 0) & 0xff) << 16

function nextPlaceholderId() {
  placeholderIdCounter = (placeholderIdCounter % 0xffff) + 1
  return placeholderIdBase + placeholderIdCounter
}

type TuiImageState =
  | { status: "loading" }
  | { status: "ready"; data: TuiImageData }
  | { status: "error"; message: string }

// Keyed by size as well as URL, so a resize is a new entry: bounded, or every
// resize would keep another full cell grid (and native payload) per image.
const previewCache = createPromiseCache<TuiImageData>({ maxEntries: 16 })

function previewBounds(maxColumns: number, maxRows: number) {
  return {
    columns: Math.max(1, Math.min(MAX_PREVIEW_COLUMNS, maxColumns)),
    rows: Math.max(1, Math.min(MAX_PREVIEW_FALLBACK_ROWS, maxRows)),
  }
}

function applySgr(sequence: string, current: { fg: RGBA; bg: RGBA }) {
  const codes = sequence.length > 0 ? sequence.split(";").map((part) => Number(part || 0)) : [0]
  let fg = current.fg
  let bg = current.bg
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index] ?? 0
    if (code === 0) {
      fg = TRANSPARENT
      bg = TRANSPARENT
      continue
    }
    if ((code === 38 || code === 48) && codes[index + 1] === 2) {
      const color = RGBA.fromInts(codes[index + 2] ?? 0, codes[index + 3] ?? 0, codes[index + 4] ?? 0, 255)
      if (code === 38) fg = color
      else bg = color
      index += 4
    }
  }
  return { fg, bg }
}

/**
 * Skip one escape sequence starting at `i` (which points at ESC).
 * Returns the index of the last consumed character.
 */
function skipEscape(line: string, i: number): { end: number; sgr?: string } {
  const next = line[i + 1]
  if (next === "[") {
    for (let j = i + 2; j < line.length; j++) {
      const code = line.charCodeAt(j)
      if (code >= 0x40 && code <= 0x7e) {
        return { end: j, sgr: line[j] === "m" ? line.slice(i + 2, j) : undefined }
      }
    }
    return { end: line.length - 1 }
  }
  if (next === "]" || next === "_" || next === "P" || next === "^") {
    const st = line.indexOf("\x1b\\", i + 2)
    const bel = line.indexOf("\x07", i + 2)
    let end = line.length - 1
    if (st !== -1) end = st + 1
    if (bel !== -1 && bel < end) end = bel
    return { end }
  }
  return { end: Math.min(i + 1, line.length - 1) }
}

/**
 * Turn half-block ANSI into OpenTUI cells. Escape sequences are consumed,
 * never stored as characters — leftover CSI in a cell is what paints the
 * TUI with raw `\x1b[` junk.
 */
export function toCellGrid(text: string, columns: number): Cell[][] {
  const rows = text.split("\n")
  const out: Cell[][] = []
  for (const line of rows) {
    const cells: Cell[] = []
    let fg = TRANSPARENT
    let bg = TRANSPARENT
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!
      if (ch === "\x1b") {
        const skipped = skipEscape(line, i)
        if (skipped.sgr !== undefined) {
          const next = applySgr(skipped.sgr, { fg, bg })
          fg = next.fg
          bg = next.bg
        }
        i = skipped.end
        continue
      }
      if (ch.charCodeAt(0) < 0x20) continue
      cells.push({ char: ch, fg, bg })
    }
    while (cells.length < columns) cells.push({ char: " ", fg: TRANSPARENT, bg: TRANSPARENT })
    if (cells.length > columns) cells.length = columns
    out.push(cells)
  }
  return out
}

export async function loadTuiImage(
  url: string,
  maxColumns: number,
  maxRows: number,
  live: LiveCapabilities | null,
  cell: CellMetrics,
  signal: AbortSignal,
  env: Record<string, string | undefined> = process.env,
  decoderOverride?: Decoder,
): Promise<TuiImageData> {
  const bytes = await readImageSource(url, signal)
  if (signal.aborted) throw new Error("aborted")
  const capabilities = applyLiveCapabilities(detectCapabilities(), live)
  const bounds = previewBounds(maxColumns, maxRows)
  const kind = chooseInlineImageRenderer(capabilities, env)

  if (kind === "kitty") {
    const decoder = decoderOverride ?? (await pickDecoder())
    const image = await decoder(bytes)
    if (image.width <= 0 || image.height <= 0) throw new Error("decoder produced a zero-sized image")
    const fitted = fitOverlayCells(image.width, image.height, bounds, cell)
    const target =
      image.width === fitted.pixelWidth && image.height === fitted.pixelHeight
        ? image
        : resize(image, fitted.pixelWidth, fitted.pixelHeight)
    const id = nextPlaceholderId()
    const color = kittyIdColor(id)
    return {
      url,
      host: hostForUrl(url),
      width: image.width,
      height: image.height,
      columns: fitted.columns,
      rows: [],
      nativeBytes: encodeKittyVirtual(target, { id, columns: fitted.columns, rows: fitted.rows }),
      placeholder: {
        rows: kittyPlaceholderGrid(fitted.columns, fitted.rows),
        fg: RGBA.fromInts(color.r, color.g, color.b, 255),
      },
      renderer: "kitty",
    }
  }

  let overlay: TuiImageData["overlay"]
  const decoder = decoderOverride ?? (await pickDecoder())
  const image = await decoder(bytes)
  signal.throwIfAborted()
  if (kind === "ade") {
    try {
      const fitted = fitOverlayCells(image.width, image.height, bounds, cell)
      if (fitted.pixelWidth * fitted.pixelHeight > 4_000_000) throw new Error("native preview is too large")
      const target = resize(image, fitted.pixelWidth, fitted.pixelHeight)
      overlay = { bytes: encodeAdeImage(target, fitted), rows: fitted.rows }
      bounds.columns = fitted.columns
      bounds.rows = fitted.rows
    } catch {
      // A failed native encode must not remove the usable half-block preview.
    }
  }
  const result = await renderImage({
    input: bytes,
    decoder: () => image,
    columns: bounds.columns,
    rows: bounds.rows,
    capabilities,
    renderer: "halfblock",
  })
  const fallback = result.output as string
  const rows = toCellGrid(fallback, overlay ? bounds.columns : result.columns)
  if (overlay) {
    while (rows.length < overlay.rows)
      rows.push(Array.from({ length: bounds.columns }, () => ({ char: " ", fg: TRANSPARENT, bg: TRANSPARENT })))
  }
  return {
    url,
    host: hostForUrl(url),
    width: image.width,
    height: image.height,
    columns: overlay ? bounds.columns : result.columns,
    rows,
    renderer: overlay ? "ade" : "halfblock",
    overlay,
  }
}

function cachedTuiImage(
  url: string,
  maxColumns: number,
  maxRows: number,
  live: LiveCapabilities | null,
  cell: CellMetrics,
  signal: AbortSignal,
) {
  const bounds = previewBounds(maxColumns, maxRows)
  const env = { ...process.env }
  const kind = chooseInlineImageRenderer(applyLiveCapabilities(detectCapabilities(), live), env)
  const key = `${bounds.columns}x${bounds.rows}\n${Math.round(cell.width)}x${Math.round(cell.height)}\n${JSON.stringify(live)}\n${kind}\n${env.ADE_PANE_ID ?? ""}\n${env.ADE_MAILBOX ?? ""}\n${url}`
  return previewCache.load(
    key,
    (loadSignal) => loadTuiImage(url, bounds.columns, bounds.rows, live, cell, loadSignal, env),
    signal,
  )
}

export function inlineImageViewport(box: Pick<BoxRenderable, "parent">): OverlayRect | undefined {
  for (let parent = box.parent; parent; parent = parent.parent) {
    if (parent instanceof ScrollBoxRenderable) {
      const view = parent.viewport
      return { x: view.x, y: view.y, columns: view.width, rows: view.height }
    }
  }
  return undefined
}

function TuiImage(props: {
  url: string
  maxColumns: number
  maxRows: number
  writer?: TuiImageWriter
  onOpen: () => void
  /** The key that opens the chooser, as the user has it bound; empty when unbound. */
  openKey: string
  overlaysEnabled: () => boolean
}) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [state, setState] = createSignal<TuiImageState>({ status: "loading" })
  const [imageBox, setImageBox] = createSignal<BoxRenderable>()
  const [overlayFailed, setOverlayFailed] = createSignal(false)

  createEffect(() => {
    const current = state()
    const box = imageBox()
    if (current.status !== "ready" || !current.data.overlay || !box || overlayFailed()) return
    const native = current.data.overlay
    const viewport = () => inlineImageViewport(box)
    const release = untrack(() =>
      registerNativeOverlay(renderer, {
        box,
        bytes: native.bytes,
        columns: current.data.columns,
        rows: native.rows,
        inline: true,
        viewport,
        enabled: props.overlaysEnabled,
        writer: props.writer,
        onError: () => setOverlayFailed(true),
      }),
    )
    onCleanup(release)
  })

  createEffect(() => {
    const controller = new AbortController()
    const url = props.url
    setState({ status: "loading" })
    setOverlayFailed(false)
    const live = (renderer.capabilities ?? null) as LiveCapabilities | null
    const cell = cellSize(renderer.resolution, renderer.terminalWidth, renderer.terminalHeight)
    void cachedTuiImage(url, props.maxColumns, props.maxRows, live, cell, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          if (data.nativeBytes !== undefined && !data.transmitted) {
            data.transmitted = true
            const writer = props.writer ?? defaultWriter
            writer(data.nativeBytes)
          }
          setState({ status: "ready", data })
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        })
      })
    onCleanup(() => controller.abort())
  })

  return (
    <box
      marginTop={1}
      paddingLeft={1}
      border={["left"]}
      borderColor={theme.border.default}
      flexDirection="column"
      flexShrink={0}
      onMouseUp={(event) => {
        event.stopPropagation()
        props.onOpen()
      }}
    >
      <Switch>
        <Match when={state().status === "loading"}>
          <text fg={theme.foreground.muted}>{IMAGE_LOADING}</text>
        </Match>
        <Match when={state().status === "error" ? (state() as { status: "error"; message: string }) : undefined}>
          {(error) => <text fg={theme.foreground.muted}>Image preview unavailable: {error().message}</text>}
        </Match>
        <Match
          when={state().status === "ready" ? (state() as { status: "ready"; data: TuiImageData }).data : undefined}
        >
          {(data) => (
            <>
              <text fg={theme.foreground.muted}>{imageCaption(props.openKey)}</text>
              <Show when={data().placeholder}>
                {(placeholder) => (
                  <box marginTop={1} flexDirection="column" flexShrink={0}>
                    <For each={placeholder().rows}>{(row) => <text fg={placeholder().fg}>{row}</text>}</For>
                  </box>
                )}
              </Show>
              <Show when={data().rows.length > 0}>
                <box ref={setImageBox} marginTop={1} flexDirection="column" flexShrink={0}>
                  <For each={data().rows}>
                    {(row) => (
                      <text>
                        <For each={row}>{(cell) => <span style={{ fg: cell.fg, bg: cell.bg }}>{cell.char}</span>}</For>
                      </text>
                    )}
                  </For>
                </box>
              </Show>
            </>
          )}
        </Match>
      </Switch>
    </box>
  )
}

export function TuiImageList(props: {
  text?: string
  urls?: string[]
  maxColumns: number
  maxRows: number
  limit?: number
  writer?: TuiImageWriter
}) {
  const urls = createMemo(() => {
    const limit = props.limit ?? 2
    const seen = new Set<string>()
    const result: string[] = []
    const add = (value: string, explicit: boolean) => {
      const url = cleanPreviewUrl(value)
      if (!url || seen.has(url)) return
      if (!isImageCandidate(url, explicit)) return
      seen.add(url)
      result.push(url)
    }
    for (const url of props.urls ?? []) {
      add(url, true)
      if (result.length >= limit) return result
    }
    for (const url of extractTuiImageUrls(props.text ?? "", limit)) {
      add(url, false)
      if (result.length >= limit) return result
    }
    return result
  })

  // Opening an image needs the dialog, the command palette and the keybinds,
  // so only a message that has images asks for them. Every text part and tool
  // mounts a list, and most have nothing to show: they should not each hold
  // palette entries, nor need the app's providers to be drawn at all.
  return (
    <Show when={urls().length > 0}>
      <TuiImageEntries urls={urls()} maxColumns={props.maxColumns} maxRows={props.maxRows} writer={props.writer} />
    </Show>
  )
}

function TuiImageEntries(props: { urls: string[]; maxColumns: number; maxRows: number; writer?: TuiImageWriter }) {
  const dialog = useDialog()
  const command = useCommandDialog()
  const keybind = useKeybind()
  const [openState, setOpenState] = createSignal("")
  const [openFailed, setOpenFailed] = createSignal(false)
  const { theme } = useTheme()
  let opening: AbortController | undefined
  onCleanup(() => opening?.abort())
  const openImage = async (url: string) => {
    if (opening) return
    const controller = new AbortController()
    opening = controller
    setOpenFailed(false)
    setOpenState(IMAGE_OPENING)
    try {
      await openFullResolutionImage(url, controller.signal)
      if (!controller.signal.aborted) setOpenState(IMAGE_OPENED)
    } catch (error) {
      if (!controller.signal.aborted) {
        setOpenFailed(true)
        setOpenState(imageOpenFailure(error))
      }
    } finally {
      opening = undefined
    }
  }
  const urls = () => props.urls

  // The chooser is a command like any other, so its key is `image_open` in the
  // config, shows in the palette and in the keybind sheet, and is matched by
  // the command registry. It used to be ctrl+shift+o, matched here by hand:
  // xterm 6, which ADE draws with, sends nothing for ctrl+shift+letter, and a
  // classic terminal sends plain ctrl+o, which went back a session tab instead.
  onCleanup(
    command.register(() => [
      {
        title: "Open full-resolution image",
        value: "images.choose",
        category: "Images",
        keybind: "image_open",
        onSelect: () => {
          const options = command
            .all()
            .filter((item) => item.category === "Images" && item.value.startsWith("image.open."))
          dialog.replace(() => <DialogSelect title="Open full-resolution image" options={options} />)
        },
      },
      ...urls().map((url, index) => ({
        title: `Open image ${index + 1}: ${hostForUrl(url)}`,
        value: `image.open.${url}`,
        category: "Images",
        onSelect: () => {
          dialog.clear()
          void openImage(url)
        },
      })),
    ]),
  )

  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={urls()}>
        {(url) => (
          <TuiImage
            url={url}
            maxColumns={props.maxColumns}
            maxRows={props.maxRows}
            writer={props.writer}
            onOpen={() => void openImage(url)}
            openKey={keybind.print("image_open")}
            overlaysEnabled={() => dialog.stack.length === 0}
          />
        )}
      </For>
      <Show when={openState()}>
        <text fg={openFailed() ? theme.status.error.fg : undefined}>{openState()}</text>
      </Show>
    </box>
  )
}
