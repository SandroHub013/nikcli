/*
 * The rows a terminal box really holds (ade/pannello-righe).
 *
 * xterm's FitAddon (0.11) reads the height of the element the terminal is
 * opened in from its computed style. ADE sizes every box `border-box`, so that
 * height includes the box's own padding, and the pane gives its terminal 42 px
 * of top padding to clear the header pill (`pane.css`). FitAddon then counted
 * those 42 px as rows: in an 836 px box with 17.59 px cells it proposed 47
 * rows where 45 fit, and the last two — the CLIs' statusline under the prompt,
 * in every pane — were drawn below the box and cut off.
 */

/** A box as its computed style gives it, in pixels. */
export interface TerminalBox {
  readonly height: number
  readonly borderBox: boolean
  readonly paddingTop: number
  readonly paddingBottom: number
  readonly borderTop: number
  readonly borderBottom: number
}

/** The rows that fit in the box's content, where the text is drawn. Never fewer than one. */
export function rowsInside(box: TerminalBox, cellHeight: number): number {
  const content = box.borderBox
    ? box.height - box.paddingTop - box.paddingBottom - box.borderTop - box.borderBottom
    : box.height
  return Math.max(1, Math.floor(content / cellHeight))
}

/** A box as `getComputedStyle` reports it. */
export function terminalBox(style: Pick<CSSStyleDeclaration, "getPropertyValue">): TerminalBox {
  const px = (name: string) => parseFloat(style.getPropertyValue(name)) || 0
  return {
    height: px("height"),
    borderBox: style.getPropertyValue("box-sizing") === "border-box",
    paddingTop: px("padding-top"),
    paddingBottom: px("padding-bottom"),
    borderTop: px("border-top-width"),
    borderBottom: px("border-bottom-width"),
  }
}

/*
 * And again when the cell changes without the box changing (Verifiche,
 * pannello-righe-scatti, BASSO 1): moved to a screen of another scale, a
 * window keeps its logical size, so the box's ResizeObserver says nothing,
 * but the cell goes from 17.61 to 18 px and 21 rows ran 7 px past the box.
 */

interface Subscription {
  dispose(): void
}

/** The part of xterm's private render service this reads: the same one `cellHeightOf` reads. */
interface CellSource {
  readonly _core?: { readonly _renderService?: { readonly onDimensionsChange?: (listener: () => void) => Subscription } }
}

/** The part of `window` the fallback needs. */
export interface ScaleWindow {
  readonly devicePixelRatio: number
  matchMedia(query: string): { addEventListener(type: "change", listener: () => void): void; removeEventListener(type: "change", listener: () => void): void }
  requestAnimationFrame(callback: () => void): number
}

/**
 * Calls `changed` whenever the terminal's cell may have changed size; returns
 * the unsubscribe.
 *
 * Two signals, because xterm 6 gives none for a new scale:
 * `onDimensionsChange` fires on a resize and on an option change (a font),
 * not on a change of the device pixel ratio, which xterm handles on its own
 * (`handleDevicePixelRatioChange`, read in xterm.mjs). So the scale is watched
 * here too, with the same media query xterm uses, and `changed` waits a frame
 * for xterm to have measured the new cell.
 */
export function watchCellSize(terminal: unknown, changed: () => void, win?: ScaleWindow): () => void {
  const service = (terminal as CellSource)._core?._renderService
  const subscription = typeof service?.onDimensionsChange === "function" ? service.onDimensionsChange.call(service, changed) : undefined
  let stopped = false
  let query: ReturnType<ScaleWindow["matchMedia"]> | undefined
  const listen = () => {
    if (!win) return
    query = win.matchMedia(`(resolution: ${win.devicePixelRatio}dppx)`)
    query.addEventListener("change", onChange)
  }
  function onChange() {
    query?.removeEventListener("change", onChange)
    if (stopped) return
    listen()
    win!.requestAnimationFrame(() => {
      if (!stopped) changed()
    })
  }
  listen()
  return () => {
    stopped = true
    subscription?.dispose()
    query?.removeEventListener("change", onChange)
  }
}
