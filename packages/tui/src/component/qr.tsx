import { RGBA } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { createEffect, createMemo, For, on, onCleanup, Show } from "solid-js";
import {
  createPixelImage,
  deleteKittyVirtual,
  detectCapabilities,
  encodeKittyVirtual,
  kittyIdColor,
  kittyPlaceholderGrid,
  setPixel,
  supportsKittyUnicodePlaceholders,
} from "@nikcli-ai/tui-image";
import { shouldUseAsciiQR } from "@nikcli-ai/util/win32";
import { cellSize } from "@tui/util/browser-frames";
import { scheduleOverlayRepaint } from "@tui/util/repaint";

/**
 * A QR is black on white, not themed.
 *
 * `surface.base`/`foreground.default` are a contrast pair picked for reading
 * text, and some themes make that pair a tinted near-pair — fine for prose,
 * marginal for a phone camera. The symbol also has to stay scannable when the
 * theme is light, where those two swap roles. Pure black and white is the only
 * pair that is right in every theme.
 */
const QR_DARK = RGBA.fromInts(0, 0, 0, 255);
const QR_LIGHT = RGBA.fromInts(255, 255, 255, 255);

export type QRRenderMode = "half-block" | "ascii";

export function qrRenderMode(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.Dict<string> = process.env,
): QRRenderMode {
  return shouldUseAsciiQR(platform, env) ? "ascii" : "half-block";
}

export function padQRMatrix(matrix: boolean[][], margin = 1): boolean[][] {
  if (matrix.length === 0) return [];
  const width = matrix[0]?.length ?? 0;
  const blank = Array(width + margin * 2).fill(false) as boolean[];
  return [
    ...Array.from({ length: margin }, () => [...blank]),
    ...matrix.map(
      (row) =>
        [
          ...Array(margin).fill(false),
          ...row,
          ...Array(margin).fill(false),
        ] as boolean[],
    ),
    ...Array.from({ length: margin }, () => [...blank]),
  ];
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
  const padded = padQRMatrix(matrix, margin);
  if (padded.length === 0) return [];
  const width = padded[0]?.length ?? 0;
  if (padded.length % 2 !== 0)
    padded.push(Array(width).fill(false) as boolean[]);

  const rows: string[] = [];
  for (let row = 0; row < padded.length; row += 2) {
    let value = "";
    for (let column = 0; column < width; column++) {
      const top = padded[row]?.[column] ?? false;
      const bottom = padded[row + 1]?.[column] ?? false;
      value += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    rows.push(value);
  }
  return rows;
}

export function qrModuleCount(matrix: boolean[][], margin = 1): number {
  return (matrix[0]?.length ?? 0) + margin * 2;
}

/**
 * Columns the on-screen symbol occupies, including the 1-cell padding the
 * `<QRCode>` box adds on each side.
 *
 * ASCII mode paints two spaces per module so the square stays square without
 * `█▀▄` — those glyphs are missing from Windows raster fonts and measure two
 * columns under a CJK code page.
 */
export function qrRenderWidth(
  matrix: boolean[][],
  margin = 1,
  mode: QRRenderMode = qrRenderMode(),
): number {
  const modules = qrModuleCount(matrix, margin);
  return modules * (mode === "ascii" ? 2 : 1) + 2;
}

export function qrRenderHeight(
  matrix: boolean[][],
  margin = 1,
  mode: QRRenderMode = qrRenderMode(),
): number {
  const modules = matrix.length + margin * 2;
  return mode === "ascii" ? modules : Math.ceil(modules / 2);
}

/**
 * Inner dialog cells left for the pairing QR after panel padding and chrome.
 *
 * `xlarge` is `min(120, termWidth - 8)` with 2+2 panel pad and 1+1 dialog
 * pad. Title, status and the key hints take about 8 rows. A QR that is
 * taller or wider than this budget cannot be scanned — scrolling or clipping
 * a symbol drops finder patterns.
 */
export function qrDialogBudget(
  termWidth: number,
  termHeight: number,
): { columns: number; rows: number } {
  const dialogWidth = Math.min(120, Math.max(1, termWidth - 8));
  const innerWidth = Math.max(8, dialogWidth - 6);
  const innerHeight = Math.max(8, termHeight - 8);
  return {
    columns: innerWidth,
    rows: Math.max(6, innerHeight - 8),
  };
}

/**
 * Cell rectangle that keeps a QR square in *pixels*.
 *
 * Terminal cells are about twice as tall as they are wide, so `columns ≈
 * rows * cellAspect`. Kitty / Ghostty / herdr then scale the bitmap into
 * that rectangle — the only way to shrink a pairing symbol below one
 * module per cell without shearing it.
 */
export function qrImagePlacement(
  maxColumns: number,
  maxRows: number,
  cellAspect = 2,
): { columns: number; rows: number } {
  const cols = Math.max(1, Math.floor(maxColumns));
  const rowsBudget = Math.max(1, Math.floor(maxRows));
  const aspect = cellAspect > 0 ? cellAspect : 2;
  let rows = Math.min(rowsBudget, Math.max(1, Math.floor(cols / aspect)));
  let columns = Math.min(cols, Math.max(1, Math.round(rows * aspect)));
  if (columns > cols) {
    columns = cols;
    rows = Math.max(1, Math.floor(columns / aspect));
  }
  if (rows > rowsBudget) {
    rows = rowsBudget;
    columns = Math.min(cols, Math.max(1, Math.round(rows * aspect)));
  }
  return {
    columns: Math.max(1, Math.min(cols, columns)),
    rows: Math.max(1, Math.min(rowsBudget, rows)),
  };
}

export function qrCanImageFit(env: NodeJS.Dict<string> = process.env): boolean {
  return supportsKittyUnicodePlaceholders(
    detectCapabilities(undefined, env),
    env,
  );
}

export function qrFittedSize(
  matrix: boolean[][],
  maxColumns: number,
  maxRows: number,
  options: { mode?: QRRenderMode; image?: boolean } = {},
): { width: number; height: number; image: boolean } {
  const mode = options.mode ?? qrRenderMode();
  const width = qrRenderWidth(matrix, 1, mode);
  const height = qrRenderHeight(matrix, 1, mode);
  if (width <= maxColumns && height <= maxRows) {
    return { width, height, image: false };
  }
  if (options.image) {
    const placed = qrImagePlacement(maxColumns, maxRows);
    return { width: placed.columns, height: placed.rows, image: true };
  }
  // Cell art cannot shrink below one module per cell. Clipping it drops
  // finder patterns and the phone cannot scan; keep the full symbol.
  return { width, height, image: false };
}

export function qrToPixelImage(
  matrix: boolean[][],
  modulePixels = 4,
  margin = 1,
) {
  const padded = padQRMatrix(matrix, margin);
  const modules = padded.length;
  const size = Math.max(1, modules * Math.max(1, modulePixels));
  const image = createPixelImage(size, size, [255, 255, 255, 255]);
  const scale = Math.max(1, modulePixels);
  for (let row = 0; row < modules; row++) {
    for (let column = 0; column < modules; column++) {
      if (!padded[row]?.[column]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          setPixel(
            image,
            column * scale + dx,
            row * scale + dy,
            [0, 0, 0, 255],
          );
        }
      }
    }
  }
  return image;
}

let qrPlaceholderId = 0;
const qrPlaceholderBase =
  (((typeof process !== "undefined" ? process.pid : 0) ?? 0) & 0xff) << 16;

function nextQRPlaceholderId() {
  qrPlaceholderId = (qrPlaceholderId % 0xffff) + 1;
  return qrPlaceholderBase + qrPlaceholderId;
}

function writeKitty(bytes: string) {
  if (typeof process === "undefined" || !process.stdout) return;
  try {
    process.stdout.write(bytes);
  } catch {
    // The TUI keeps going; a dropped graphics frame is not fatal.
  }
}

export function asciiQRRuns(
  row: boolean[],
): { dark: boolean; count: number }[] {
  const runs: { dark: boolean; count: number }[] = [];
  for (const dark of row) {
    const last = runs[runs.length - 1];
    if (last && last.dark === dark) last.count++;
    else runs.push({ dark, count: 1 });
  }
  return runs;
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
export function useQRRepaint(
  matrix: () => boolean[][] | undefined,
): () => void {
  const renderer = useRenderer();
  let cancel: (() => void) | undefined;
  const repaint = () => {
    cancel?.();
    cancel = scheduleOverlayRepaint(renderer, 150);
  };
  createEffect(
    on(matrix, (value) => {
      if (!value) return;
      repaint();
    }),
  );
  onCleanup(() => cancel?.());
  return repaint;
}

function QRCodeHalfBlock(props: { matrix: boolean[][] }) {
  const rows = createMemo(() => renderQRRows(props.matrix));
  return (
    <box
      backgroundColor={QR_LIGHT}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
    >
      <For each={rows()}>
        {(row) => (
          <text fg={QR_DARK} bg={QR_LIGHT} wrapMode="none">
            {row}
          </text>
        )}
      </For>
    </box>
  );
}

/**
 * One run of same-color modules per `<text>`, two spaces each.
 *
 * A renderable per module would multiply the bytes of every frame that draws
 * the symbol, and a bigger frame is exactly what Windows consoles drop. Runs
 * keep the cell count close to the half-block path while staying in ASCII.
 */
function QRCodeAscii(props: { matrix: boolean[][] }) {
  const padded = createMemo(() => padQRMatrix(props.matrix));
  return (
    <box
      backgroundColor={QR_LIGHT}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
    >
      <For each={padded()}>
        {(row) => (
          <box flexDirection="row">
            <For each={asciiQRRuns(row)}>
              {(run) => (
                <text
                  fg={run.dark ? QR_DARK : QR_LIGHT}
                  bg={run.dark ? QR_DARK : QR_LIGHT}
                  wrapMode="none"
                >
                  {"  ".repeat(run.count)}
                </text>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  );
}

/**
 * Kitty / Ghostty / herdr: a real bitmap over placeholder cells, sized to
 * the pane. Cell art cannot shrink below one module per cell; this can, and
 * the terminal keeps the square so a phone can still scan it.
 */
function QRCodeImage(props: {
  matrix: boolean[][];
  columns: number;
  rows: number;
}) {
  const renderer = useRenderer();
  const id = nextQRPlaceholderId();
  const color = kittyIdColor(id);

  createEffect(() => {
    const image = qrToPixelImage(props.matrix);
    const cell = cellSize(
      renderer.resolution,
      renderer.terminalWidth,
      renderer.terminalHeight,
    );
    const placed = qrImagePlacement(
      props.columns,
      props.rows,
      cell.width > 0 ? cell.height / cell.width : 2,
    );
    writeKitty(
      encodeKittyVirtual(image, {
        id,
        columns: placed.columns,
        rows: placed.rows,
      }),
    );
  });

  onCleanup(() => writeKitty(deleteKittyVirtual(id)));

  const placeholders = createMemo(() => {
    const cell = cellSize(
      renderer.resolution,
      renderer.terminalWidth,
      renderer.terminalHeight,
    );
    const placed = qrImagePlacement(
      props.columns,
      props.rows,
      cell.width > 0 ? cell.height / cell.width : 2,
    );
    return kittyPlaceholderGrid(placed.columns, placed.rows);
  });

  return (
    <box backgroundColor={QR_LIGHT} flexDirection="column" flexShrink={0}>
      <For each={placeholders()}>
        {(row) => (
          <text
            fg={RGBA.fromInts(color.r, color.g, color.b, 255)}
            wrapMode="none"
          >
            {row}
          </text>
        )}
      </For>
    </box>
  );
}

/**
 * One `<text>` per row, not one per module — except on Windows, where the
 * row is run-length encoded spaces instead of `█▀▄`. When the cell-art
 * symbol would overflow the pane and the terminal can composite a bitmap
 * (herdr, Ghostty, Kitty), shrink it into a square image instead.
 */
export function QRCode(props: {
  matrix: boolean[][];
  maxColumns?: number;
  maxRows?: number;
}) {
  const fitted = createMemo(() => {
    if (props.maxColumns === undefined || props.maxRows === undefined) {
      return { image: false, width: 0, height: 0 };
    }
    return qrFittedSize(props.matrix, props.maxColumns, props.maxRows, {
      image: qrCanImageFit(),
    });
  });
  return (
    <Show
      when={fitted().image}
      fallback={
        shouldUseAsciiQR() ? (
          <QRCodeAscii matrix={props.matrix} />
        ) : (
          <QRCodeHalfBlock matrix={props.matrix} />
        )
      }
    >
      <QRCodeImage
        matrix={props.matrix}
        columns={fitted().width}
        rows={fitted().height}
      />
    </Show>
  );
}
