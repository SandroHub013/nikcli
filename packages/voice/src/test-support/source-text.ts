/**
 * Code without its layout, for the tests that read a source file: no
 * whitespace at all, and no trailing comma before a closing bracket or at the
 * end. Prettier, which the release runs over the repository, breaks a long
 * call over lines; the code is the same. The same as ADE's
 * `test-support/source-text.ts`. Compare two of these, never one with raw
 * source.
 */
export function codeOf(text: string): string {
  return text
    .replace(/\s+/g, "")
    .replace(/,([)\]}>])/g, "$1")
    .replace(/,$/, "")
}
