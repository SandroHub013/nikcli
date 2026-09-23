/**
 * Whether a file pane is covered whole during a take (D68, audit of 0.7.7).
 *
 * The field covers of `record/sensitive.ts` reached the editor only by luck —
 * its `aria-label` carries the path, so `secrets.json` was covered and `.env`
 * was not — and the markdown preview and the viewers never. The terminal's rule
 * is turned the same way here: a file is covered for its name, or for any line
 * the terminal's reader would blur. A lockfile full of hashes is covered too,
 * and that is the right direction to be wrong in.
 */
import { rowIsClean } from "../terminal/recording-cover"

/** The names secrets are kept under, matched on the file name alone. */
const SECRET_FILE_NAMES = [
  /^\.env/i,
  /\.(?:pem|key|p12|pfx)$/i,
  // A private SSH key: `id_rsa`, `id_ed25519`. `id_rsa.pub` is the public half.
  /^id_[^.]*$/,
  /^\.(?:npmrc|netrc|pypirc|git-credentials)$/i,
  /credential/i,
  /secret/i,
]

export function fileIsSensitive(path: string, text: string | undefined): boolean {
  const name = path.split(/[\\/]/).pop() ?? path
  if (SECRET_FILE_NAMES.some((rule) => rule.test(name))) return true
  return (text ?? "").split(/\r?\n/).some((line) => !rowIsClean(line))
}
