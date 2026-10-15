import { RGBA } from "@opentui/core"
import { blackOrWhite, contrastRatio, ensureContrast, over } from "./contrast"

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
const DIFF_GUTTER_MIN = 4.5
const TERMINAL_DARK = RGBA.fromInts(12, 12, 12)
const TERMINAL_LIGHT = RGBA.fromInts(255, 255, 255)

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

function statusPair(base: RGBA, hue: RGBA, alpha: number): StatusPair {
  return {
    fg: hue,
    bg: tint(base, hue, alpha),
  }
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
  // A transparent background shows the terminal's: assume the default of Windows Terminal and conhost when dark,
  // white when light (the backgrounds the triple-A review measured transparent themes on).
  const ground = over(colors.background, options.mode === "dark" ? TERMINAL_DARK : TERMINAL_LIGHT)
  // The selected row: the theme's text for it, or black or white; when neither reaches 7:1 on `primary`, the fill
  // moves in lightness rather than the text giving up.
  const badgeFg = options.hasSelectedListItemText ? colors.selectedListItemText : contrastFg(colors.primary)
  const badgeBg = ensureContrast(colors.primary, [badgeFg], BADGE_MIN)
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
      error: statusPair(colors.background, colors.error, fill),
      warning: statusPair(colors.background, colors.warning, fill),
      success: statusPair(colors.background, colors.success, fill),
      info: statusPair(colors.background, colors.info, fill),
    },
    border: {
      default: colors.border,
      subtle: colors.borderSubtle,
      active: colors.borderActive,
      focus: tint(colors.primary, colors.text, 0.35),
    },
    badge: {
      fg: badgeFg,
      bg: badgeBg,
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
