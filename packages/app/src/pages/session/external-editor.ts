/**
 * Opening a file in the editor you already have open.
 *
 * The agent works in this app; the fifty other things you do with a file happen
 * in your editor. Every agent panel on the market bridges that — Claude Code
 * Desktop offers "Open in" against VS Code, Cursor and Zed from any file path it
 * shows — and until now the only way across was to find the file yourself.
 *
 * The schemes are the editors' own. What they get wrong when hand-rolled is
 * Windows: `C:\Users\x` has to become `/C:/Users/x`, and a path with a space in
 * it has to survive being a URL.
 */

export type ExternalEditor = "vscode" | "cursor" | "zed" | "windsurf"

export const EXTERNAL_EDITORS: ReadonlyArray<{ id: ExternalEditor; label: string }> = [
  { id: "vscode", label: "VS Code" },
  { id: "cursor", label: "Cursor" },
  { id: "zed", label: "Zed" },
  { id: "windsurf", label: "Windsurf" },
]

const SCHEME: Record<ExternalEditor, string> = {
  vscode: "vscode",
  cursor: "cursor",
  zed: "zed",
  windsurf: "windsurf",
}

/**
 * The URI that opens `path` in `editor`, or undefined when there is nothing to
 * open. A relative path is refused rather than guessed at: the editor would
 * resolve it against its own working directory and open the wrong file, or
 * nothing, with no way for the user to tell which.
 */
export function externalEditorUri(input: {
  editor: ExternalEditor
  /** Absolute. Windows drive letters and POSIX roots both accepted. */
  path: string
  line?: number
}): string | undefined {
  const raw = input.path.trim()
  if (!raw) return undefined

  const slashed = raw.replace(/\\/g, "/")
  const isWindows = /^[A-Za-z]:\//.test(slashed)
  if (!isWindows && !slashed.startsWith("/")) return undefined

  // A leading slash before the drive letter: `vscode://file/C:/x` is read as a
  // host of `file` and a path of `/C:/x`, which is what these schemes expect.
  const absolute = isWindows ? `/${slashed}` : slashed
  const segments = absolute.split("/").map((segment) => encodeURIComponent(segment))
  // A drive letter's colon must survive — `C%3A` is not a drive — but only the
  // drive's. Applying it to every segment let a POSIX directory literally named
  // `c:` (legal on Linux and macOS) emit a colon the editor reads as the
  // line-number separator, opening the wrong place in the wrong file.
  if (isWindows) {
    // index 0 is the empty string before the leading slash; the drive is index 1.
    segments[1] = segments[1]!.replace(/^([A-Za-z])%3A$/i, "$1:")
  }
  const encoded = segments.join("/")

  const line = input.line && input.line > 0 ? `:${Math.trunc(input.line)}` : ""
  return `${SCHEME[input.editor]}://file${encoded}${line}`
}
