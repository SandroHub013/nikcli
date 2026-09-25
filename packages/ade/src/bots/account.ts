/**
 * How a Claude or Codex bot is paid for (B10).
 *
 * Kept in ADE, by the bot file's path, never in the file. A repository must
 * not be able to decide to spend the user's key: a frontmatter `account:`
 * is ignored (`readAgentFile` does not read it). Only the name of a key in
 * ADE's index is stored. The value stays in the system keychain.
 */

export const ACCOUNT_PLAN = { mode: "plan" } as const

export type BotAccount = typeof ACCOUNT_PLAN | { readonly mode: "key"; readonly key: string }

export interface AccountStore {
  get: (bot: string) => BotAccount
  set: (bot: string, account: BotAccount) => void
}

const STORAGE_KEY = "ade.bots.account"

/**
 * What was saved, as far as it can be trusted.
 *
 * Anything unexpected — a broken value, an unknown mode, a key that is not
 * a name, an extra field — is a subscription. A subscription spends the CLI
 * login, and the spawn flag strips inherited API keys.
 */
export function parseAccount(value: unknown): BotAccount {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ACCOUNT_PLAN
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.length === 1 && keys[0] === "mode" && record["mode"] === "plan") return ACCOUNT_PLAN
  const key = record["key"]
  if (
    keys.length === 2 &&
    keys[0] === "key" &&
    keys[1] === "mode" &&
    record["mode"] === "key" &&
    typeof key === "string" &&
    key.trim().length > 0 &&
    !/[\r\n]/.test(key)
  ) {
    return { mode: "key", key: key.trim() }
  }
  return ACCOUNT_PLAN
}

function readMap(raw: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw ?? "{}") as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function localAccountStore(key: string = STORAGE_KEY): AccountStore {
  return {
    get: (bot) => parseAccount(readMap(localStorage.getItem(key))[bot]),
    set: (bot, account) => {
      try {
        const next = readMap(localStorage.getItem(key))
        next[bot] = parseAccount(account)
        localStorage.setItem(key, JSON.stringify(next))
      } catch {
        // Storage blocked: the choice lasts until ADE closes, then plan.
      }
    },
  }
}

export function memoryAccountStore(): AccountStore {
  const saved = new Map<string, BotAccount>()
  return {
    get: (bot) => saved.get(bot) ?? ACCOUNT_PLAN,
    set: (bot, account) => void saved.set(bot, parseAccount(account)),
  }
}
