/**
 * The permission rules of a chat session (C5).
 *
 * nikcli decides a tool call with the last rule that matches, in this order:
 * the agent's rules, then the session's, then what the user approved for the
 * project with «always» (`permission/next.ts`, `evaluate`). An agent starts
 * from `"*": "allow"` and the user's config comes after it: on this machine
 * `build` has `bash *: allow`, so a chat trusting the agent would run any
 * shell command without asking. So the chat puts its own rules on every
 * session it makes, where they come after the agent's and win:
 *
 * - everything asks first (`* *: ask`), MCP tools and tools added tomorrow
 *   included;
 * - reading and searching are allowed, with nikcli's own guard on `.env`
 *   files kept (the session's `read *` would otherwise lift it);
 * - the model may ask the user a question (the chat shows it) and keep its
 *   todo list;
 * - subagents are denied: a `task` runs in a child session with its own
 *   rules, which these do not reach (`tool/task.ts`); and so are the
 *   computer, the browser and plan mode, as for the bots.
 *
 * Two things these rules do not cover, said where it matters: an «always»
 * the user gave earlier in the project (in the TUI too) still wins, since it
 * comes last; and a server started with `--auto` approves every «ask».
 *
 * A session made elsewhere (the TUI, the web app) has other rules, or none:
 * the chat does not send to it (`hasChatRules`), it offers a new one.
 */

import type { Session } from "@nikcli-ai/sdk/httpapi"

export interface PermissionRule {
  readonly permission: string
  readonly pattern: string
  readonly action: "allow" | "ask" | "deny"
}

const allow = (permission: string, pattern = "*"): PermissionRule => ({ permission, pattern, action: "allow" })
const ask = (permission: string, pattern = "*"): PermissionRule => ({ permission, pattern, action: "ask" })
const deny = (permission: string): PermissionRule => ({ permission, pattern: "*", action: "deny" })

/** Tools that only read the project, or only talk to the user. */
const READING = [
  "grep",
  "glob",
  "list",
  "tree",
  "lsp",
  "codesearch",
  "repo_overview",
  "context_collect",
  "context_related",
  "context_diagnostics",
  "memory_search",
  "todoread",
  "todowrite",
  "question",
]

export const CHAT_PERMISSION: readonly PermissionRule[] = [
  ask("*"),
  allow("read"),
  ask("read", "*.env"),
  ask("read", "*.env.*"),
  allow("read", "*.env.example"),
  ...READING.map((tool) => allow(tool)),
  deny("task"),
  deny("computer"),
  deny("browser_control"),
  deny("plan_enter"),
  deny("plan_exit"),
]

const same = (a: { permission?: unknown; pattern?: unknown; action?: unknown }, b: PermissionRule) =>
  a.permission === b.permission && a.pattern === b.pattern && a.action === b.action

/** Whether `session` was made by the chat: its rules end with the chat's own, in order. */
export function hasChatRules(session: Pick<Session, "permission"> | undefined): boolean {
  const rules = (session?.permission ?? []) as readonly { permission?: unknown; pattern?: unknown; action?: unknown }[]
  if (rules.length < CHAT_PERMISSION.length) return false
  const tail = rules.slice(rules.length - CHAT_PERMISSION.length)
  return tail.every((rule, index) => same(rule, CHAT_PERMISSION[index]!))
}
