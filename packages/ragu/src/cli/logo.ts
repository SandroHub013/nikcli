import { Log } from "@ragu/util/log"

const log = Log.create({ service: "logo" })

/** What the banner is printed on: whether it takes 24-bit colour, and how wide it is (undefined when not a terminal). */
export interface Terminal {
  truecolor: boolean
  columns: number | undefined
}

/** The name, for terminals that cannot draw the pixel banner: no 24-bit colour, `NO_COLOR`, or narrower than the banner. */
export const PLAIN_LOGO = "RAGU CODE"

/** Below this many columns the banner is not drawn. */
export const BANNER_MIN_COLUMNS = 60

// The "A+D orizzontale" mark (pot and wordmark), one letter per pixel, `.` empty: the `combo` grid of the
// Ragu Code logo generator (ade-team/design/ragu-code/gen/logo.mjs), drawn two pixel rows per text row.
const PALETTE: Record<string, string> = {
  a: "#120d0b",
  b: "#24501a",
  c: "#3a0f0b",
  d: "#4f8a2e",
  e: "#5a1712",
  f: "#7fb850",
  g: "#a3271b",
  h: "#c98f2a",
  i: "#df4a2b",
  j: "#e8dfcf",
  k: "#f1c14f",
  l: "#f39a6b",
  m: "#f4e7cd",
}
const ART = [
  "...........................................................",
  "...........................................................",
  "............j...j...j......................................",
  "...............j...........................................",
  "...........................................................",
  "...............j...........................................",
  "..........j.....j.....j....................................",
  ".................j.........................................",
  "...........j.....j...j.....................................",
  "............j....jaaj......................................",
  "..........aaaaaaaadbaa.....................................",
  "........aalimililddiliaa..........llll...lll...lll..l...l..",
  ".....aaaililililililililaaa.......iccci.i.cci.i.cci.ic..ic.",
  "....ammmmmmmmmmmmmmmmmmmmmma......lc..lclc..lclc...clc..lc.",
  "....aeeeeeeeeeeeeeeeeeeeeeea......iiii.ciiiiiciciii.ic..ic.",
  "..aaaaiiiiiiiiiiiiiiiiiiiiaaaa....icicc.icccicic.cicic..ic.",
  ".aeeeegigigigigigigigigigieeeea...gc.g..gc..gcgc..gcgc..gc.",
  ".aeeeeiiiliiigiiigiiigiiigeeeea...gc..g.gc..gc.ggggc.ggg.c.",
  "..aaaagiligigigigigigigigiaaaa.....c...c.c...c..cccc..ccc..",
  ".....aigigigigigigigigigiga.......hkh....khkh....khk....h..",
  ".....agglggggggggggggggggga..........kkkk....kkkk...kkkk...",
  ".....aggglgggggggggggggggga................................",
  ".....aeglgegggegggegggeggga........fff...fff..ffff..fffff..",
  ".....agggggggggggggggggggga.......f.ccf.f.ccf.fcccf.fccccc.",
  ".....aegegegegegegegegegega.......dc...cdc..dcdc..dcdc.....",
  ".....agegegegegegegegegegea.......dc....dc..dcdc..dcdddd...",
  ".....aeeeeeeeeeeeeeeeeeeeea.......bc....bc..bcbc..bcbcccc..",
  "......aeeeeeeeeeeeeeeeeeea........dc..d.dc..dcdc..dcdc.....",
  ".......aaaaaaaaaaaaaaaaaa..........bbb.c.bbb.cbbbb.cbbbbb..",
  "....................................ccc...ccc..cccc..ccccc.",
  "...........................................................",
]

/** The banner's width in columns. */
export const BANNER_WIDTH = ART[0].length

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(";")
const fg = (key: string) => `\x1b[38;2;${rgb(PALETTE[key])}m`
const bg = (key: string) => `\x1b[48;2;${rgb(PALETTE[key])}m`

/** The pixel banner in half blocks: the top pixel of a cell is its foreground, the bottom one its background. */
function banner(pad: string): string[] {
  const lines: string[] = []
  for (let y = 0; y < ART.length; y += 2) {
    const top = ART[y]
    const bottom = ART[y + 1] ?? ""
    let end = BANNER_WIDTH
    while (end > 0 && top[end - 1] === "." && (bottom[end - 1] ?? ".") === ".") end--
    let line = pad
    for (let x = 0; x < end; x++) {
      const t = top[x] === "." ? undefined : top[x]
      const b = bottom[x] === "." || bottom[x] === undefined ? undefined : bottom[x]
      if (t && b) line += t === b ? `${fg(t)}█\x1b[0m` : `${fg(t)}${bg(b)}▀\x1b[0m`
      else if (t) line += `${fg(t)}▀\x1b[0m`
      else if (b) line += `${fg(b)}▄\x1b[0m`
      else line += " "
    }
    lines.push(line)
  }
  return lines
}

/** True when the terminal is known to take 24-bit colour, and `NO_COLOR` is not set. */
export function truecolor(env: Record<string, string | undefined>): boolean {
  if (env.NO_COLOR) return false
  const colorterm = (env.COLORTERM ?? "").toLowerCase()
  if (colorterm === "truecolor" || colorterm === "24bit") return true
  if (env.WT_SESSION) return true
  if (["iTerm.app", "vscode", "WezTerm", "ghostty"].includes(env.TERM_PROGRAM ?? "")) return true
  return /direct|kitty|alacritty/.test(env.TERM ?? "")
}

/** The terminal the CLI prints on: stderr, where `UI.println` writes. */
export function currentTerminal(): Terminal {
  return { truecolor: truecolor(process.env), columns: process.stderr.columns ?? process.stdout.columns }
}

/**
 * The Ragu Code logo: the pixel banner, or the name in plain text where the banner cannot be drawn (no 24-bit
 * colour, `NO_COLOR`, not a terminal, or fewer than `BANNER_MIN_COLUMNS` columns once `pad` is added).
 */
export function logo(pad?: string, terminal: Terminal = currentTerminal()): string {
  const prefix = pad ?? ""
  const columns = terminal.columns ?? 0
  const drawn = terminal.truecolor && columns >= BANNER_MIN_COLUMNS && columns >= prefix.length + BANNER_WIDTH
  const output = drawn ? banner(prefix).join("\n").trimEnd() : prefix + PLAIN_LOGO
  log.debug("Logo rendered", { hasPad: Boolean(pad), drawn })
  return output
}
