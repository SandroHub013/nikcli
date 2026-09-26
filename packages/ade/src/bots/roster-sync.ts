/**
 * Keeping the bots' roster in step with their files.
 *
 * A bot is a file anyone can change: an editor, a shell, nikcli itself. ADE
 * re-read the roster only after its own changes, so a `model:` added from
 * outside still showed «a pagamento» in the room form until a restart
 * (Verifiche). There is no watcher on those folders; the roster is read again
 * when the window comes back and every `ROSTER_CHECK_MS` while it shows, and
 * moves only when the files say something else (`rosterChanged`).
 */

import type { AgentFile } from "./nikcli"

/** How often the roster is compared with its files while the window shows. */
export const ROSTER_CHECK_MS = 15_000

/** Whether the files read now differ from the roster shown. The bots are plain data read off the files. */
export function rosterChanged(shown: readonly AgentFile[] | undefined, read: readonly AgentFile[]): boolean {
  return JSON.stringify(shown ?? []) !== JSON.stringify(read)
}
