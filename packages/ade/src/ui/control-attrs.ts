/**
 * The attributes behind Button, IconButton, Field, Notice and EmptyState, as pure functions.
 *
 * Kept apart from `controls.tsx` for the reason `layout-attrs.ts` is: a `.tsx` does not load under `bun test`
 * without the Solid transform, and the vocabulary (a variant is one of four words, a size one of three) is the
 * design rule, so it is worth pinning where nothing has to render. `controls.css` matches these attributes and
 * nothing else; a sheet that wants a different look overrides the sheet, never the markup.
 */

/** DS-8: the four looks of a text button. Tone is a variant, never a colour a sheet picks. */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger"
/** Heights are `--ade-control-sm/md/lg`: 22, 26 and 32. */
export type ControlSize = "sm" | "md" | "lg"
/** An icon button is 20 or 26 square; the window controls (44) keep their own sheet. */
export type IconButtonSize = "sm" | "md"
export type NoticeTone = "info" | "working" | "error"

export type ControlAttrs = Record<`data-${string}` | `aria-${string}`, string | undefined>

export const BUTTON_VARIANTS: readonly ButtonVariant[] = ["primary", "secondary", "ghost", "danger"]
export const CONTROL_SIZES: readonly ControlSize[] = ["sm", "md", "lg"]

export function buttonAttrs(
  options: { variant?: ButtonVariant; size?: ControlSize; loading?: boolean } = {},
): ControlAttrs {
  return {
    "data-ui": "button",
    "data-variant": options.variant ?? "secondary",
    "data-size": options.size ?? "md",
    "aria-busy": options.loading ? "true" : undefined,
  }
}

export function iconButtonAttrs(options: { size?: IconButtonSize } = {}): ControlAttrs {
  return { "data-ui": "icon-button", "data-size": options.size ?? "md" }
}

export function fieldAttrs(
  options: { size?: Exclude<ControlSize, "lg">; shape?: "pill"; invalid?: boolean } = {},
): ControlAttrs {
  return {
    "data-ui": "field",
    "data-size": options.size ?? "md",
    "data-shape": options.shape,
    "aria-invalid": options.invalid ? "true" : undefined,
  }
}

/**
 * An error is announced as an alert (UX-20); the rest wait their turn as a status, so a progress note does not
 * interrupt what a screen reader is saying.
 */
export function noticeAttrs(tone: NoticeTone = "info"): ControlAttrs & { role: "alert" | "status" } {
  return { "data-ui": "notice", "data-tone": tone, role: tone === "error" ? "alert" : "status" }
}

export function emptyStateAttrs(): ControlAttrs {
  return { "data-ui": "empty-state" }
}
