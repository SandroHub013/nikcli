/**
 * The rules a message from a chat meets before it becomes a turn (G4).
 *
 * Rust already let through only an authorized sender in a private chat. Here:
 * - the commands a chat can give (`/nuova`, `/ferma`, `/stato`, `/aiuto`);
 * - how the text is framed for the model: a fixed line with the platform and
 *   the sender's name, quoted and cleaned, marked as a label and not an order;
 * - a ceiling of messages per chat per hour, against a loop of messages;
 * - who may run a turn on a plan (D92: in V1 only the owner is ever paired);
 * - the bot's trust checked again on every turn, with no dialog: a file or a
 *   project configuration changed since the user approved it is refused, and
 *   the chat is told to approve it again in ADE.
 */

import { t } from "../../i18n"
import { readAgentFile, type AgentFile } from "../nikcli"
import { admitProject, type AdmitProjectDeps } from "../project-trust"
import { admit, selfApproval, type TrustStore } from "../trust"
import { runnerById } from "../runners"

export type ChatCommand = "new" | "stop" | "status" | "help"

const COMMANDS: Record<string, ChatCommand> = {
  nuova: "new",
  new: "new",
  ferma: "stop",
  stop: "stop",
  stato: "status",
  status: "status",
  aiuto: "help",
  help: "help",
  // What Telegram sends when a chat with the bot is opened.
  start: "help",
}

/** The command `text` is, if it is one: `/ferma`, or `/ferma@MioBot` as Telegram writes it in a menu. */
export function chatCommand(text: string): ChatCommand | undefined {
  const match = /^\/([a-z]+)(?:@\w+)?\s*$/i.exec(text.trim())
  return match ? COMMANDS[match[1]!.toLowerCase()] : undefined
}

const PLATFORM_NAMES: Record<string, string> = { telegram: "Telegram", discord: "Discord", slack: "Slack" }

/** A sender's name as the model may read it: one line, no quotes to break out of, short. */
export function quotedName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, "")
    .replace(/[«»"`]/g, "'")
    .trim()
  const short = [...cleaned].slice(0, 40).join("")
  return short || "?"
}

/** What the turn is given: the fixed line, then the chat's text as it came. */
export function framedMessage(platform: string, senderName: string, text: string): string {
  return `${t("gateway.header", PLATFORM_NAMES[platform] ?? platform, quotedName(senderName))}\n\n${text}`
}

/** Messages a chat may send in an hour before the bot stops answering it for a while. */
export const CHAT_MESSAGES_PER_HOUR = 30
const HOUR_MS = 60 * 60_000

/** The times a chat wrote, the last hour's only; `allowed` when this one is within the ceiling. */
export function countMessage(times: readonly number[], now: number): { allowed: boolean; times: number[] } {
  const recent = times.filter((at) => now - at < HOUR_MS)
  if (recent.length >= CHAT_MESSAGES_PER_HOUR) return { allowed: false, times: recent }
  return { allowed: true, times: [...recent, now] }
}

/**
 * Whether a sender may run a turn of a bot on `runner`. A turn on a plan
 * (Claude Code, Codex) is an action of the plan's owner (D7, D88), and in V1
 * only the owner's own accounts are paired (D92): anyone else is refused,
 * with the reason, whatever the runner. Every authorized sender is the owner
 * until other people can be paired.
 */
export function mayRun(runner: string, owner: boolean): { ok: true } | { ok: false; problem: string } {
  return owner ? { ok: true } : { ok: false, problem: t("gateway.ownerOnly", runnerById(runner).label) }
}

const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()

/** A bot file inside the project is the repository's; anywhere else, the user's. */
export function scopeOf(path: string, project: string): "project" | "global" {
  return normalize(path).startsWith(`${normalize(project)}/`) ? "project" : "global"
}

export interface RecheckDeps {
  readonly bots: TrustStore
  readonly projects: TrustStore
  readonly read: (path: string) => Promise<string>
  readonly surface: AdmitProjectDeps["surface"]
}

/**
 * The bot at `path` as its file is now, if the trust the user gave in ADE
 * still holds for it; otherwise why not. Nothing is asked: a chat cannot
 * approve, and no dialog must open on a computer nobody is looking at.
 */
export async function recheckTrust(
  path: string,
  project: string,
  deps: RecheckDeps,
): Promise<{ ok: true; bot: AgentFile } | { ok: false; problem: string }> {
  const scope = scopeOf(path, project)
  let text: string
  try {
    text = await deps.read(path)
  } catch {
    return { ok: false, problem: t("bots.trust.unreadable", path.split(/[\\/]/).pop() ?? path) }
  }
  const bot = readAgentFile({ path, scope, text })
  /*
   * From a chat the shell is denied through nikcli's configuration, and a
   * bot's own file overrides it: a nikcli bot that grants itself a tool —
   * the user's own included — does not run from a chat (G5).
   */
  const granted = runnerById(bot.runner).id === "nikcli" ? selfApproval(text) : undefined
  if (granted !== undefined) return { ok: false, problem: t("gateway.selfGrant", bot.identifier, granted) }
  const retrust = t("gateway.retrust", bot.identifier)
  const never = () => false
  const verdict = await admit(bot, { store: deps.bots, read: async () => text, confirm: never })
  if (!verdict.ok) return { ok: false, problem: verdict.problem ?? retrust }
  if (scope === "project" && runnerById(bot.runner).id === "nikcli") {
    const configuration = await admitProject(project, { store: deps.projects, surface: deps.surface, confirm: never })
    if (!configuration.ok) return { ok: false, problem: retrust }
  }
  return { ok: true, bot }
}
