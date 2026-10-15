import { RGBA } from "@opentui/core"
import {
  blackOrWhite,
  contrastRatio,
  contrastScore,
  ensureContrast,
  ensureContrastFor,
  over,
  toOklch,
} from "./contrast"

export type StatusPair = {
  fg: RGBA
  bg: RGBA
}

export type SemanticTokens = {
  surface: {
    base: RGBA
    panel: RGBA
    offset: RGBA
    overlay: RGBA
  }
  foreground: {
    default: RGBA
    muted: RGBA
    subtle: RGBA
  }
  accent: {
    fg: RGBA
    bg: RGBA
    border: RGBA
    /** Document `accent` hue — distinct from `fg`, which is `primary`. */
    alt: RGBA
    /** Document `secondary` hue. */
    secondary: RGBA
  }
  status: {
    error: StatusPair
    warning: StatusPair
    success: StatusPair
    info: StatusPair
  }
  border: {
    default: RGBA
    subtle: RGBA
    active: RGBA
    focus: RGBA
  }
  badge: StatusPair
  syntax: {
    comment: RGBA
    keyword: RGBA
    function: RGBA
    variable: RGBA
    string: RGBA
    number: RGBA
    type: RGBA
    operator: RGBA
    punctuation: RGBA
  }
  markdown: {
    text: RGBA
    heading: RGBA
    link: RGBA
    linkText: RGBA
    code: RGBA
    blockQuote: RGBA
    emph: RGBA
    strong: RGBA
    horizontalRule: RGBA
    listItem: RGBA
    listEnumeration: RGBA
    image: RGBA
    imageText: RGBA
    codeBlock: RGBA
  }
  diff: {
    added: RGBA
    removed: RGBA
    context: RGBA
    addedBg: RGBA
    removedBg: RGBA
    contextBg: RGBA
    hunkHeader: RGBA
    highlightAdded: RGBA
    highlightRemoved: RGBA
    lineNumber: RGBA
    addedLineNumberBg: RGBA
    removedLineNumberBg: RGBA
  }
  thinkingOpacity: number
}

export type TokenSource = {
  primary: RGBA
  secondary: RGBA
  accent: RGBA
  error: RGBA
  warning: RGBA
  success: RGBA
  info: RGBA
  text: RGBA
  textMuted: RGBA
  selectedListItemText: RGBA
  background: RGBA
  backgroundPanel: RGBA
  backgroundElement: RGBA
  backgroundMenu: RGBA
  border: RGBA
  borderActive: RGBA
  borderSubtle: RGBA
  syntaxComment: RGBA
  syntaxKeyword: RGBA
  syntaxFunction: RGBA
  syntaxVariable: RGBA
  syntaxString: RGBA
  syntaxNumber: RGBA
  syntaxType: RGBA
  syntaxOperator: RGBA
  syntaxPunctuation: RGBA
  markdownText: RGBA
  markdownHeading: RGBA
  markdownLink: RGBA
  markdownLinkText: RGBA
  markdownCode: RGBA
  markdownBlockQuote: RGBA
  markdownEmph: RGBA
  markdownStrong: RGBA
  markdownHorizontalRule: RGBA
  markdownListItem: RGBA
  markdownListEnumeration: RGBA
  markdownImage: RGBA
  markdownImageText: RGBA
  markdownCodeBlock: RGBA
  diffAdded: RGBA
  diffRemoved: RGBA
  diffContext: RGBA
  diffAddedBg: RGBA
  diffRemovedBg: RGBA
  diffContextBg: RGBA
  diffHunkHeader: RGBA
  diffHighlightAdded: RGBA
  diffHighlightRemoved: RGBA
  diffLineNumber: RGBA
  diffAddedLineNumberBg: RGBA
  diffRemovedLineNumberBg: RGBA
}

export function tint(base: RGBA, overlay: RGBA, alpha: number): RGBA {
  const r = base.r + (overlay.r - base.r) * alpha
  const g = base.g + (overlay.g - base.g) * alpha
  const b = base.b + (overlay.b - base.b) * alpha
  return RGBA.fromInts(Math.round(r * 255), Math.round(g * 255), Math.round(b * 255))
}

export function luminance(color: RGBA): number {
  return 0.299 * color.r + 0.587 * color.g + 0.114 * color.b
}

/**
 * Black or white text for a filled `bg`, by the WCAG ratio. Not by `luminance` above: BT.601 luma calls a saturated
 * red or blue dark and puts white on it, where black reads better (white on #ff0000 is 4:1, black 5.3:1).
 */
export function contrastFg(bg: RGBA): RGBA {
  return blackOrWhite(bg)
}

/** The floors of the triple-A review for the colours the engine derives. */
const SUBTLE_MIN = 4.5
const BADGE_MIN = 7
/** The selected row's fill is also the bar that marks it in a dialog: a mark, 3:1 on the dialog. */
const BAR_MIN = 3
const DIFF_GUTTER_MIN = 4.5
const TERMINAL_DARK = RGBA.fromInts(12, 12, 12)
const TERMINAL_LIGHT = RGBA.fromInts(255, 255, 255)
const BLACK = RGBA.fromInts(0, 0, 0)
const WHITE = RGBA.fromInts(255, 255, 255)

/**
 * The background as the screen shows it. A transparent one shows the terminal's: assume the default of Windows
 * Terminal and conhost when dark, white when light (the backgrounds the triple-A review measured transparent themes on).
 */
export function groundOf(background: RGBA, mode: "dark" | "light"): RGBA {
  return over(background, mode === "dark" ? TERMINAL_DARK : TERMINAL_LIGHT)
}

/**
 * `muted` faded toward the background, the colour of what a tool hides («▸ N more lines») and of its markers. Faded
 * less than the 40 % it starts from when that would drop it under 4.5:1 on the background, and moved in lightness
 * when even `muted` is under it.
 */
function subtleOf(muted: RGBA, ground: RGBA): RGBA {
  for (let step = 8; step >= 1; step--) {
    const faded = tint(muted, ground, step * 0.05)
    if (contrastRatio(faded, ground) >= SUBTLE_MIN) return faded
  }
  return ensureContrast(muted, [ground], SUBTLE_MIN)
}

/**
 * The selected row: its text and its fill. The text is the theme's (`selectedListItemText`) or black or white; the
 * fill is `primary`, moved in lightness only when the text does not reach 7:1 on it or the fill does not stand 3:1
 * off the dialog it marks a row in. The theme's own text wins when some fill works with it. Otherwise black and white
 * are both tried and the pair whose fill moves least wins: on a light theme a mid-tone primary under black text would
 * go pale and vanish into the dialog, where under white it only has to darken a little.
 */
function badgeOf(primary: RGBA, overlay: RGBA, declared: RGBA | undefined): StatusPair {
  const pair = (fg: RGBA) => {
    const targets = [
      { bg: fg, min: BADGE_MIN },
      { bg: overlay, min: BAR_MIN },
    ]
    const bg = ensureContrastFor(primary, targets)
    if (contrastScore(bg, targets) < 1) return undefined
    return { fg, bg, distance: Math.abs(toOklch(bg).l - toOklch(primary).l) }
  }
  const own = declared && pair(declared)
  if (own) return { fg: own.fg, bg: own.bg }
  const best = [BLACK, WHITE]
    .map(pair)
    .filter((p) => p !== undefined)
    .sort((a, b) => a.distance - b.distance)[0]
  if (best) return { fg: best.fg, bg: best.bg }
  // No fill does both: the text reads, the bar is what gives.
  const fg = declared ?? contrastFg(primary)
  return { fg, bg: ensureContrast(primary, [fg], BADGE_MIN) }
}

/**
 * A state's colour and the fill tinted with it, the background of the error and warning toasts. The fill is the
 * background with `alpha` of the hue, less when that would leave the hue under 4.5:1 on it or the toast's text (the
 * default at 7:1, muted at 4.5:1) unreadable.
 */
function statusPair(base: RGBA, hue: RGBA, alpha: number, text: RGBA, muted: RGBA): StatusPair {
  const targets = [
    { colour: hue, min: 4.5 },
    { colour: text, min: 7 },
    { colour: muted, min: 4.5 },
  ]
  const readable = (bg: RGBA) => targets.every((t) => contrastRatio(t.colour, bg) >= t.min)
  for (let step = Math.round(alpha / 0.02); step > 0; step--) {
    const bg = tint(base, hue, step * 0.02)
    if (readable(bg)) return { fg: hue, bg }
  }
  return { fg: hue, bg: tint(base, hue, 0) }
}

export function deriveSemanticTokens(
  colors: TokenSource,
  options: {
    hasSelectedListItemText: boolean
    thinkingOpacity: number
    mode: "dark" | "light"
  },
): SemanticTokens {
  const fill = options.mode === "dark" ? 0.28 : 0.16
  const ground = groundOf(colors.background, options.mode)
  const badge = badgeOf(
    colors.primary,
    over(colors.backgroundMenu, ground),
    options.hasSelectedListItemText ? colors.selectedListItemText : undefined,
  )
  // The diff's gutter: the line number on each line's gutter fill, and the + and - signs, which the renderer draws in
  // the gutter too, on the fill of their own line. Both were near invisible (line numbers at 1.1:1 in the default
  // theme) and the signs are the one cue left to whoever cannot tell the green from the red.
  const gutter = (c: RGBA) => over(c, ground)
  const lineNumber = ensureContrast(
    colors.diffLineNumber,
    [colors.diffContextBg, colors.diffAddedLineNumberBg, colors.diffRemovedLineNumberBg].map(gutter),
    DIFF_GUTTER_MIN,
  )
  const highlightAdded = ensureContrast(
    colors.diffHighlightAdded,
    [gutter(colors.diffAddedLineNumberBg)],
    DIFF_GUTTER_MIN,
  )
  const highlightRemoved = ensureContrast(
    colors.diffHighlightRemoved,
    [gutter(colors.diffRemovedLineNumberBg)],
    DIFF_GUTTER_MIN,
  )
  return {
    surface: {
      base: colors.background,
      panel: colors.backgroundPanel,
      offset: colors.backgroundElement,
      overlay: colors.backgroundMenu,
    },
    foreground: {
      default: colors.text,
      muted: colors.textMuted,
      subtle: subtleOf(colors.textMuted, ground),
    },
    accent: {
      fg: colors.primary,
      bg: tint(colors.background, colors.primary, fill),
      border: tint(colors.primary, colors.text, 0.35),
      alt: colors.accent,
      secondary: colors.secondary,
    },
    status: {
      error: statusPair(ground, colors.error, fill, colors.text, colors.textMuted),
      warning: statusPair(ground, colors.warning, fill, colors.text, colors.textMuted),
      success: statusPair(ground, colors.success, fill, colors.text, colors.textMuted),
      info: statusPair(ground, colors.info, fill, colors.text, colors.textMuted),
    },
    border: {
      default: colors.border,
      subtle: colors.borderSubtle,
      active: colors.borderActive,
      focus: tint(colors.primary, colors.text, 0.35),
    },
    badge: {
      fg: badge.fg,
      bg: badge.bg,
    },
    syntax: {
      comment: colors.syntaxComment,
      keyword: colors.syntaxKeyword,
      function: colors.syntaxFunction,
      variable: colors.syntaxVariable,
      string: colors.syntaxString,
      number: colors.syntaxNumber,
      type: colors.syntaxType,
      operator: colors.syntaxOperator,
      punctuation: colors.syntaxPunctuation,
    },
    markdown: {
      text: colors.markdownText,
      heading: colors.markdownHeading,
      link: colors.markdownLink,
      linkText: colors.markdownLinkText,
      code: colors.markdownCode,
      blockQuote: colors.markdownBlockQuote,
      emph: colors.markdownEmph,
      strong: colors.markdownStrong,
      horizontalRule: colors.markdownHorizontalRule,
      listItem: colors.markdownListItem,
      listEnumeration: colors.markdownListEnumeration,
      image: colors.markdownImage,
      imageText: colors.markdownImageText,
      codeBlock: colors.markdownCodeBlock,
    },
    diff: {
      added: colors.diffAdded,
      removed: colors.diffRemoved,
      context: colors.diffContext,
      addedBg: colors.diffAddedBg,
      removedBg: colors.diffRemovedBg,
      contextBg: colors.diffContextBg,
      hunkHeader: colors.diffHunkHeader,
      highlightAdded,
      highlightRemoved,
      lineNumber,
      addedLineNumberBg: colors.diffAddedLineNumberBg,
      removedLineNumberBg: colors.diffRemovedLineNumberBg,
    },
    thinkingOpacity: options.thinkingOpacity,
  }
}
