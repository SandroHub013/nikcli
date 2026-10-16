import { canWrite, runnerById } from "./runners"
import type { AgentFile } from "./ragu"

/**
 * What the bot's Permissions tab says for each program (the review, P1-P1 and P2-P1): the words are chosen here from
 * the bot, and `permissions-facts.test.ts` asks the real rules (`turnCommand` in `runners.ts`, the profiles of
 * `serve-rules.ts`) the same questions, so a rule changed without the words fails there.
 *
 * Claude Code and Codex cannot ask a question mid-turn (`-p`, `approval_policy="never"`), so what they may do is
 * decided before the turn; only ragu asks. A project's bot (`scope: "project"`) gets no shell from Claude Code and
 * a read-only sandbox from Codex, whatever its file says (`fromRepository` in `runners.ts`).
 */
type Kind = "ragu" | "claude" | "codex"

const kindOf = (bot: AgentFile): Kind => {
  const id = runnerById(bot.runner).id
  return id === "claude" || id === "codex" ? id : "ragu"
}

const shellOn = (bot: AgentFile) => !bot.disabledTools.includes("bash")

/** The words for «Nella Conversazione», and whether the bot may edit there. */
export function conversationText(bot: AgentFile) {
  const kind = kindOf(bot)
  const project = bot.scope === "project"
  if (kind === "ragu")
    return {
      key: shellOn(bot)
        ? ("bots.permissions.panelTextRagu" as const)
        : ("bots.permissions.panelTextRaguNoShell" as const),
      edits: canWrite(bot),
    }
  if (kind === "claude")
    return {
      key:
        shellOn(bot) && !project
          ? ("bots.permissions.panelTextClaude" as const)
          : ("bots.permissions.panelTextClaudeNoShell" as const),
      edits: canWrite(bot),
    }
  const writes = !project && canWrite(bot)
  return {
    key: writes ? ("bots.permissions.panelTextCodexWrite" as const) : ("bots.permissions.panelTextCodexRead" as const),
    edits: writes,
  }
}

/**
 * The words under «Sempre» when none was given (bot-ui-4, P2-2): what happens instead. ragu asks; Claude Code is
 * refused, and with no shell (switched off, or a project's bot) has nothing to be given. Codex has no «Sempre».
 */
export function alwaysEmptyKey(bot: AgentFile) {
  if (kindOf(bot) === "ragu")
    return shellOn(bot)
      ? ("bots.permissions.alwaysEmptyRagu" as const)
      : ("bots.permissions.alwaysEmptyRaguNoShell" as const)
  return conversationText(bot).key === "bots.permissions.panelTextClaude"
    ? ("bots.permissions.alwaysEmptyClaude" as const)
    : ("bots.permissions.alwaysEmptyClaudeNoShell" as const)
}

/** The words for «Da telefono», and whether the bot may edit from a chat (Codex never: its sandbox is read-only). */
export function phoneText(bot: AgentFile) {
  const kind = kindOf(bot)
  return {
    key:
      kind === "ragu"
        ? ("bots.permissions.phoneText" as const)
        : kind === "claude"
          ? ("bots.permissions.phoneTextClaude" as const)
          : ("bots.permissions.phoneTextCodex" as const),
    edits: kind !== "codex" && canWrite(bot),
  }
}

/** The words for «Nelle routine»: read-only for all three. */
export function routinesTextKey(bot: AgentFile) {
  return kindOf(bot) === "codex"
    ? ("bots.permissions.routinesTextCodex" as const)
    : ("bots.permissions.routinesText" as const)
}

/** Why a chat's turn has no switch for commands: Codex still reads with commands that only read. */
export function remoteNeverKey(bot: AgentFile) {
  return kindOf(bot) === "codex" ? ("gateway.panel.remoteNeverCodex" as const) : ("gateway.panel.remoteNever" as const)
}
