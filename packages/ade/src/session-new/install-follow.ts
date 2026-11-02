/**
 * What happens after «Installa» opens a terminal for a missing agent.
 *
 * The install pane replaces the launch form (a pane in the grid always does), so the form's own «Ricontrolla» is gone
 * by the time the installer finishes (audit UX-2). The pane therefore follows its own end: when the install line
 * succeeds the shell exits, ADE looks the agents up again, and the launcher opens with that agent ready.
 *
 * Nothing here runs a process; the host does, and passes the lookup in.
 */
import type { AgentStatus } from "./availability"

/** The agent an install pane was opened for. */
export interface InstallWatch {
  agentId: string
  label: string
}

/**
 * The line typed into the install terminal: the install command, then `exit` only if it succeeded.
 *
 * The pane is a shell, and a shell stays open after its command, so the end of the install would never be seen. With
 * `&& exit` a success closes the shell (code 0, which is what `installExit` waits for) and a failure leaves it open,
 * with the installer's error on screen for the user to read. Every catalogue line is one command, so `&&` binds to
 * all of it (a test checks that none of them holds a `||` or `;`).
 */
export function typedInstallLine(line: string): string {
  return `${line} && exit`
}

/** Whether the end of the install pane's process is worth a lookup: it ended cleanly, and was not a start that failed. */
export function installExit(watch: InstallWatch | undefined, exit: { code: number | null; failed?: string }): boolean {
  return watch !== undefined && exit.code === 0 && exit.failed === undefined
}

/**
 * Looks the agent up again once its installer has finished.
 * `ready` when it is installed now; `missing` when the installer ended cleanly but the agent is still not found
 * (a PATH the lookup cannot see yet, or an installer that did not install what its page says).
 */
export async function watchInstall(
  watch: InstallWatch,
  recheck: () => Promise<AgentStatus[]>,
): Promise<"ready" | "missing"> {
  const statuses = await recheck().catch(() => [] as AgentStatus[])
  const found = statuses.find((status) => status.agent.id === watch.agentId)
  return found && found.availability !== "assente" ? "ready" : "missing"
}
