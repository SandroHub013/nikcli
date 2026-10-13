import { TextAttributes, RGBA } from "@opentui/core"
import { For, Show } from "solid-js"
import { useTheme, tint } from "@tui/context/theme"

/*
 * The wordmark, in the pixel letters OpenCode's home uses: "ragu" muted, "code"
 * bright, like its "open"/"code". Half blocks draw two pixel rows per text row.
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
  const { theme } = useTheme()
  // Opaque on purpose: the background may be transparent (ADE draws its own),
  // and a shadow mixed from it must still be a colour.
  const shadow = (fg: RGBA) => tint(theme.surface.base, fg, 0.25)
  const row = (index: number) => [
    ...cells(LOGO_RAGU[index]!, theme.foreground.muted, shadow(theme.foreground.muted), false),
    { text: GAP, fg: theme.foreground.muted, bold: false },
    ...cells(LOGO_CODE[index]!, theme.foreground.default, shadow(theme.foreground.default), true),
  ]

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
          <span style={{ fg: theme.foreground.muted }}>
            <b>RAGU</b>
          </span>
          <span style={{ fg: theme.foreground.default }}>
            <b>CODE</b>
          </span>
        </text>
      </box>
    </Show>
  )
}
