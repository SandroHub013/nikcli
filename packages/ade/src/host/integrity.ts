/**
 * Whether a Windows folder carries the Low mandatory integrity label.
 *
 * On this kind of machine the checkout can live under `%USERPROFILE%\Favorites`,
 * which Windows labels Low on purpose (it is Internet Explorer's bookmarks
 * folder). The label is inherited by everything created inside, including
 * the `ade-desktop.exe` cargo builds. A process started from a Low image runs
 * at Low integrity, and so does everything it starts: ragu then dies on
 * `EPERM` opening its log in `%LOCALAPPDATA%`, Claude Code cannot save its
 * transcript, Codex finds its database read-only. The fix is to label the
 * build output Medium before the binary is built.
 *
 * `icacls` prints the label in the machine's language — "Mandatory Label\Low
 * Mandatory Level" in English, "Etichetta obbligatoria\Livello obbligatorio
 * basso" in Italian — so both spellings are matched.
 */
export function hasLowLabel(icaclsOutput: string): boolean {
  return icaclsOutput
    .split(/\r?\n/)
    .some((line) => /Mandatory Label\\Low Mandatory Level|Livello obbligatorio basso/i.test(line))
}

/**
 * The executables an `icacls` listing shows with the Low label, whatever the folder above them says.
 *
 * Labelling `target` Medium (`scripts/medium-target.ts`) only fixes the files made afterwards, and `/T` on the folder is skipped
 * when the folder itself is already Medium. An `ade-test.exe` or a build script left Low by an earlier cargo (started from a Low
 * process, or built before the folder was labelled) keeps running at Low, and so does everything it starts. So the executables
 * are looked at on their own.
 *
 * An entry starts at column 0 with the path and its first permission; the lines under it are indented and one of them is the
 * label. Entries that are not executables are skipped, and the path is the text up to its `.exe`.
 */
export function lowLabeledExecutables(icaclsOutput: string): string[] {
  const found: string[] = []
  let current: string | undefined
  for (const line of icaclsOutput.split(/\r?\n/)) {
    if (line.length > 0 && !/^\s/.test(line)) {
      current = line.match(/^(.+?\.exe)(?=\s)/i)?.[1]
    } else if (current && hasLowLabel(line)) {
      found.push(current)
      current = undefined
    }
  }
  return found
}
