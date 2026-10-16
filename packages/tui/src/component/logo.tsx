import { TextAttributes, RGBA } from "@opentui/core"
import { For, Show, createMemo } from "solid-js"
import { useTheme, tint } from "@tui/context/theme"
import { ensureContrast } from "@tui/context/contrast"
import { groundOf } from "@tui/context/theme-tokens"

/*
 * The wordmark, in the pixel letters OpenCode's home uses: "ragu" in tomato,
 * "code" in basil, the logo's colours. Half blocks draw two pixel rows per text row.
 * Three markers paint the inside of a letter in a shadow tone:
 *   _  a shadow cell
 *   ^  the letter's top half over a shadow cell
 *   ~  a top half in the shadow tone
 * Row 0 is the ascender (the "d"), row 4 the descender (the "g").
 */
export const LOGO_RAGU = [
  "                   ",
  "█▀▀▀ ▀▀▀█ █▀▀█ █  █",
  "█    █^^█ █__█ █__█",
  "▀    ▀▀▀▀ ▀▀▀█ ▀▀▀▀",
  "          ▀▀▀▀     ",
]
export const LOGO_CODE = [
  "             ▄     ",
  "█▀▀▀ █▀▀█ █▀▀█ █▀▀█",
  "█___ █__█ █__█ █^^^",
  "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀",
  "                   ",
]
const GAP = " "

/** The brand's tomato and basil (ade-team/design/ragu-code), the colours of «ragu» and «code» in the logo. */
export const WORDMARK = { ragu: RGBA.fromHex("#df4a2b"), code: RGBA.fromHex("#4f8a2e") }
/**
 * Coloured text's floor. Tomato and basil reach it on ink (4.7 and 4.6), not on cream (3.3 and 3.4): on a light
 * background they darken, hue kept, as far as it takes.
 */
const WORDMARK_MIN = 4.5

/** The wordmark as plain rows, markers turned into the cells they draw: for the exit summary. */
export const LOGO_LINES = LOGO_RAGU.map((left, row) =>
  `${left}${GAP}${LOGO_CODE[row]}`.replace(/_/g, " ").replace(/\^/g, "▀").replace(/~/g, "▀").trimEnd(),
)

type Cell = { text: string; fg: RGBA; bg?: RGBA; bold: boolean }

/** One row of one half of the wordmark, split into runs that share their colours. */
function cells(line: string, fg: RGBA, shadow: RGBA, bold: boolean): Cell[] {
  const runs: Cell[] = []
  for (const char of line) {
    const cell: Cell =
      char === "_"
        ? { text: " ", fg, bg: shadow, bold }
        : char === "^"
          ? { text: "▀", fg, bg: shadow, bold }
          : char === "~"
            ? { text: "▀", fg: shadow, bold }
            : { text: char, fg, bold }
    const last = runs.at(-1)
    if (last && last.fg === cell.fg && last.bg === cell.bg) last.text += cell.text
    else runs.push(cell)
  }
  return runs
}

export function Logo(props: { compact?: boolean }) {
  const { theme, mode } = useTheme()
  const colours = createMemo(() => {
    const ground = groundOf(theme.surface.base, mode())
    return {
      ragu: ensureContrast(WORDMARK.ragu, [ground], WORDMARK_MIN),
      code: ensureContrast(WORDMARK.code, [ground], WORDMARK_MIN),
    }
  })
  // Opaque on purpose: the background may be transparent (ADE draws its own),
  // and a shadow mixed from it must still be a colour.
  const shadow = (fg: RGBA) => tint(theme.surface.base, fg, 0.25)
  const row = (index: number) => {
    const { ragu, code } = colours()
    return [
      ...cells(LOGO_RAGU[index]!, ragu, shadow(ragu), false),
      { text: GAP, fg: ragu, bold: false },
      ...cells(LOGO_CODE[index]!, code, shadow(code), true),
    ]
  }

  return (
    <Show
      when={props.compact}
      fallback={
        <box flexDirection="column" flexShrink={0}>
          <For each={LOGO_RAGU.map((_, index) => index)}>
            {(index) => (
              <box flexDirection="row" height={1}>
                <For each={row(index)}>
                  {(cell) => (
                    <text
                      fg={cell.fg}
                      bg={cell.bg}
                      attributes={cell.bold ? TextAttributes.BOLD : undefined}
                      selectable={false}
                      wrapMode="none"
                    >
                      {cell.text}
                    </text>
                  )}
                </For>
              </box>
            )}
          </For>
        </box>
      }
    >
      <box height={1} flexDirection="column">
        <text selectable={false} wrapMode="none">
          <span style={{ fg: colours().ragu }}>
            <b>RAGU</b>
          </span>
          <span style={{ fg: colours().code }}>
            <b>CODE</b>
          </span>
        </text>
      </box>
    </Show>
  )
}
