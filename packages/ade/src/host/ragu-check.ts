/**
 * Whether Ragù Code is on this machine, asked the same way by Chat and Bot.
 *
 * ADE reads its PATH once, when it starts, and an installer writes the new directory to the user's environment, not to
 * this process (`Host.refreshPath`). Looking up `ragu` in the PATH ADE started with therefore says «missing» for a
 * program that was installed a minute ago. The PATH is reread, as «Ricontrolla» and the new-session form do, but only
 * when the first look found nothing: the usual case (ragu is there) costs one lookup, and where the PATH is reread by
 * a login shell (macOS, Linux) it is not paid for by everyone who has the program.
 */
export interface RaguHost {
  probe?: (command: string, arg: string) => Promise<string | null>
  refreshPath?: () => Promise<boolean>
}

/** True or false, or undefined when there is no host to ask (the browser harness): the caller keeps what it assumed. */
export async function raguFound(host: RaguHost | undefined): Promise<boolean | undefined> {
  const probe = host?.probe
  if (!probe) return undefined
  const look = async () => Boolean(await probe("ragu", "--version").catch(() => null))
  if (await look()) return true
  await host.refreshPath?.().catch(() => false)
  return look()
}
