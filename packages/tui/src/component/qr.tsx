import { RGBA } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createEffect, createMemo, For, on, onCleanup } from "solid-js"
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

/**
 * Pack a module matrix into half-block rows.
 *
 * Terminal cells are about twice as tall as they are wide, so a module per cell
 * would render the symbol stretched and most scanners would refuse it. Each
 * output row carries two module rows: the foreground paints the top half, the
 * background the bottom.
 */
export function renderQRRows(matrix: boolean[][], margin = 1): string[] {
  if (matrix.length === 0) return []
  const width = matrix[0]?.length ?? 0
  const blank = Array(width + margin * 2).fill(false) as boolean[]
  const padded = [
    ...Array.from({ length: margin }, () => [...blank]),
    ...matrix.map((row) => [...Array(margin).fill(false), ...row, ...Array(margin).fill(false)] as boolean[]),
    ...Array.from({ length: margin }, () => [...blank]),
  ]
  if (padded.length % 2 !== 0) padded.push([...blank])

  const rows: string[] = []
  for (let row = 0; row < padded.length; row += 2) {
    let value = ""
    for (let column = 0; column < blank.length; column++) {
      const top = padded[row]?.[column] ?? false
      const bottom = padded[row + 1]?.[column] ?? false
      value += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " "
    }
    rows.push(value)
  }
  return rows
}

export function qrRenderWidth(matrix: boolean[][], margin = 1): number {
  return (matrix[0]?.length ?? 0) + margin * 2 + 2
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

/**
 * One `<text>` per row, not one per module.
 *
 * A row is a single foreground/background pair, so it goes out as one escape
 * run; a renderable per module would multiply the bytes of every frame that
 * draws the symbol, and a bigger frame is exactly what Windows consoles drop.
 */
export function QRCode(props: { matrix: boolean[][] }) {
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
