/**
 * The product is «Ragu Code» in text and `ragu` where it is the command: never «Ragu» alone, never «RAGU». A development
 * build's version is the word «local», which read as «Ragu vlocal» with a «v» put in front of it.
 */
export const PRODUCT_NAME = "Ragu Code"

/** `1.431.0` → `v1.431.0`; `local` (a development build) stays `local`. */
export function shortVersion(version: string): string {
  return /^\d/.test(version) ? `v${version}` : version
}

/** «Ragu Code v1.431.0», or «Ragu Code local» for a development build. */
export function productVersion(version: string): string {
  return `${PRODUCT_NAME} ${shortVersion(version)}`
}
