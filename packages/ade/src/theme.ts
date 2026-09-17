/**
 * Pure theme resolution logic.
 *
 * No DOM access — all functions are deterministic and testable without a
 * browser. The component layer reads the preference from localStorage and
 * applies `data-theme` on `<html>`; this module only decides *which* value
 * to apply.
 */

/** The choices a user can store. */
export type Theme = "dark" | "light" | "glass" | "system"

/** The list of selectable themes in the interface. */
export const THEME_CHOICES: readonly Theme[] = ["light", "dark", "glass", "system"]

/** Concrete outcome after resolving "system". */
export type ResolvedTheme = "dark" | "light" | "glass"

/**
 * Resolve a preference to a concrete theme.
 *
 * "system" defers to the OS-level preference passed as the second argument.
 * An undefined or unrecognised preference defaults to "system" — the
 * safest fallback because it honours whatever the user already chose at
 * OS level without us having to guess.
 */
export function resolveTheme(
  pref: Theme | undefined | null,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (pref === "glass") return "glass"
  if (pref === "dark") return "dark"
  if (pref === "light") return "light"
  // "system", undefined, null, or anything else
  return systemPrefersDark ? "dark" : "light"
}

const VALID_THEMES = new Set<string>(["dark", "light", "glass", "system"])

/**
 * Parse a stored string into a Theme, tolerantly.
 *
 * Accepts any casing and trims whitespace. Returns "system" for anything
 * unrecognised so a corrupted localStorage value never crashes the UI.
 */
export function parseTheme(raw: string | null | undefined): Theme {
  if (raw == null) return "system"
  const normalised = raw.trim().toLowerCase()
  if (VALID_THEMES.has(normalised)) return normalised as Theme
  return "system"
}

/**
 * Serialize a Theme for storage. Returns the canonical lowercase string.
 */
export function serializeTheme(theme: Theme): string {
  return theme
}

/** Default opacity percentage for glass mode veil (0 to 100). */
export const DEFAULT_GLASS_OPACITY = 75

/** Minimum and maximum glass opacity percentages. */
export const MIN_GLASS_OPACITY = 0
export const MAX_GLASS_OPACITY = 100

/**
 * Clamp an opacity percentage into the [0, 100] range.
 */
export function clampGlassOpacity(val: number): number {
  if (isNaN(val)) return DEFAULT_GLASS_OPACITY
  return Math.max(MIN_GLASS_OPACITY, Math.min(MAX_GLASS_OPACITY, Math.round(val)))
}

/**
 * Parse a stored glass opacity string (0-100) into a valid number.
 */
export function parseGlassOpacity(raw: string | null | undefined): number {
  if (raw == null) return DEFAULT_GLASS_OPACITY
  const parsed = parseInt(raw, 10)
  return clampGlassOpacity(parsed)
}

