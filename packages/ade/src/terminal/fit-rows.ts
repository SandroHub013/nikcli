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
