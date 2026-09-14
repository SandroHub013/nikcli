import { RGBA } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createEffect, createMemo, For, on, onCleanup } from "solid-js"
import { shouldUseAsciiQR } from "@nikcli-ai/util/win32"
import { scheduleOverlayRepaint } from "@tui/util/repaint"

/**
 * A QR is black on white, not themed.
 *
 * `surface.base`/`foreground.default` are a contrast pair picked for reading
 * text, and some themes make that pair a tinted near-pair — fine for prose,
 * marginal for a phone camera. The symbol also has to stay scannable when the
 * theme is light, where those two swap roles. Pure black and white is the only
 * pair that is right in every theme.
 */
const QR_DARK = RGBA.fromInts(0, 0, 0, 255)
const QR_LIGHT = RGBA.fromInts(255, 255, 255, 255)

export type QRRenderMode = "half-block" | "ascii"

export function qrRenderMode(platform: NodeJS.Platform = process.platform): QRRenderMode {
  return shouldUseAsciiQR(platform) ? "ascii" : "half-block"
}

export function padQRMatrix(matrix: boolean[][], margin = 1): boolean[][] {
  if (matrix.length === 0) return []
  const width = matrix[0]?.length ?? 0
  const blank = Array(width + margin * 2).fill(false) as boolean[]
  return [
    ...Array.from({ length: margin }, () => [...blank]),
    ...matrix.map((row) => [...Array(margin).fill(false), ...row, ...Array(margin).fill(false)] as boolean[]),
    ...Array.from({ length: margin }, () => [...blank]),
  ]
}

/**
 * Pack a module matrix into half-block rows.
 *
 * Terminal cells are about twice as tall as they are wide, so a module per cell
 * would render the symbol stretched and most scanners would refuse it. Each
 * output row carries two module rows: the foreground paints the top half, the
 * background the bottom.
 */
export function renderQRRows(matrix: boolean[][], margin = 1): string[] {
  const padded = padQRMatrix(matrix, margin)
  if (padded.length === 0) return []
  const width = padded[0]?.length ?? 0
  if (padded.length % 2 !== 0) padded.push(Array(width).fill(false) as boolean[])

  const rows: string[] = []
  for (let row = 0; row < padded.length; row += 2) {
    let value = ""
    for (let column = 0; column < width; column++) {
      const top = padded[row]?.[column] ?? false
      const bottom = padded[row + 1]?.[column] ?? false
      value += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " "
    }
    rows.push(value)
  }
  return rows
}

export function qrModuleCount(matrix: boolean[][], margin = 1): number {
  return (matrix[0]?.length ?? 0) + margin * 2
}

/**
 * Columns the on-screen symbol occupies, including the 1-cell padding the
 * `<QRCode>` box adds on each side.
 *
 * ASCII mode paints two spaces per module so the square stays square without
 * `█▀▄` — those glyphs are missing from Windows raster fonts and measure two
 * columns under a CJK code page.
 */
export function qrRenderWidth(matrix: boolean[][], margin = 1, mode: QRRenderMode = qrRenderMode()): number {
  const modules = qrModuleCount(matrix, margin)
  return modules * (mode === "ascii" ? 2 : 1) + 2
}

export function qrRenderHeight(matrix: boolean[][], margin = 1, mode: QRRenderMode = qrRenderMode()): number {
  const modules = matrix.length + margin * 2
  return mode === "ascii" ? modules : Math.ceil(modules / 2)
}

export function asciiQRRuns(row: boolean[]): { dark: boolean; count: number }[] {
  const runs: { dark: boolean; count: number }[] = []
  for (const dark of row) {
    const last = runs[runs.length - 1]
    if (last && last.dark === dark) last.count++
    else runs.push({ dark, count: 1 })
  }
  return runs
}

/**
 * Repaint the screen after a QR lands.
 *
 * The frame that adds a QR flips a thousand cells in one go, which is the frame
 * shape Windows consoles truncate — and the half of it that gets lost is gone
 * for good, because the renderer writes each cell only when it changes. Ask for
 * a full repaint once the symbol is on screen. `scheduleOverlayRepaint` is a
 * no-op everywhere else.
 */
export function useQRRepaint(matrix: () => boolean[][] | undefined): () => void {
  const renderer = useRenderer()
  let cancel: (() => void) | undefined
  const repaint = () => {
    cancel?.()
    cancel = scheduleOverlayRepaint(renderer, 150)
  }
  createEffect(
    on(matrix, (value) => {
      if (!value) return
      repaint()
    }),
  )
  onCleanup(() => cancel?.())
  return repaint
}

function QRCodeHalfBlock(props: { matrix: boolean[][] }) {
  const rows = createMemo(() => renderQRRows(props.matrix))
  return (
    <box backgroundColor={QR_LIGHT} paddingLeft={1} paddingRight={1} flexDirection="column">
      <For each={rows()}>
        {(row) => (
          <text fg={QR_DARK} bg={QR_LIGHT} wrapMode="none">
            {row}
          </text>
        )}
      </For>
    </box>
  )
}

/**
 * One run of same-color modules per `<text>`, two spaces each.
 *
 * A renderable per module would multiply the bytes of every frame that draws
 * the symbol, and a bigger frame is exactly what Windows consoles drop. Runs
 * keep the cell count close to the half-block path while staying in ASCII.
 */
function QRCodeAscii(props: { matrix: boolean[][] }) {
  const padded = createMemo(() => padQRMatrix(props.matrix))
  return (
    <box backgroundColor={QR_LIGHT} paddingLeft={1} paddingRight={1} flexDirection="column">
      <For each={padded()}>
        {(row) => (
          <box flexDirection="row">
            <For each={asciiQRRuns(row)}>
              {(run) => (
                <text fg={run.dark ? QR_DARK : QR_LIGHT} bg={run.dark ? QR_DARK : QR_LIGHT} wrapMode="none">
                  {"  ".repeat(run.count)}
                </text>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  )
}

/**
 * One `<text>` per row, not one per module — except on Windows, where the
 * row is run-length encoded spaces instead of `█▀▄`.
 */
export function QRCode(props: { matrix: boolean[][] }) {
  if (shouldUseAsciiQR()) return <QRCodeAscii matrix={props.matrix} />
  return <QRCodeHalfBlock matrix={props.matrix} />
}
