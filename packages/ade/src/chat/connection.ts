/**
 * The chat's way to a project on the nikcli server (C2).
 *
 * A request with a directory makes the server load that folder's `.nikcli/`,
 * plugins included, which run as code. So a folder is admitted first, as the Bots
 * are (B3b, `project-trust.ts`): the same fingerprint, the same yes kept in
 * the same place. Until then no request leaves, the server's start included
 * (ADE's own server would start in that folder); after a no, none ever does
 * for it (C1 review, M1).
 *
 * The client handed back is bound to that one folder: a request that names
 * another one, in the header or the query, is refused here, so the SDK's
 * per-call `directory` cannot reach a folder nobody said yes to.
 *
 * The trust is checked again before every request, not only at the opening
 * (C2 review, BASSO): a `git pull` that adds a plugin to `.nikcli/` during a
 * conversation reaches the server the next time it builds the instance, and
 * that can be any request. Unchanged, the check is silent; changed, the user
 * is asked again, in front of the screen. After a no the connection is closed
 * for good: every request fails with `ChatRefused`, without asking again, so
 * a stream that reconnects does not reopen the dialog each time.
 *
 * Requests that arrive together wait for one check, and so for one dialog
 * (`admitProject` shares the check under way); a yes holds for `FRESH_MS`, so
 * a bootstrap's burst reads the project's files once (C2 review, M2 and
 * BASSO). Only a no with its reason closes the chat: an answer without one is
 * no answer, and that request fails as one that can be tried again.
 */

import { createNikcliClient, type NikcliClient, type ProviderList, type Agent } from "@nikcli-ai/sdk/client"
import { t } from "../i18n"
import { askDialog } from "../host/ask"
import { admitProject, PROJECT_TRUST_KEY, projectSurface } from "../bots/project-trust"
import { projectFs } from "../bots/store"
import { localTrustStore } from "../bots/trust"
import { SERVER_BASE, serverFetch, tauriServerBridge, type ServerBridge } from "./transport"

export interface ChatCatalog {
  readonly providerList?: ProviderList
  readonly agents?: readonly Agent[]
  readonly configModel?: string
}

/**
 * Loads provider list, agents, and config model using an admitted chat client.
 */
export async function loadChatCatalog(client: NikcliClient): Promise<ChatCatalog> {
  const [pRes, aRes, cRes] = await Promise.all([
    client.provider.list().catch(() => undefined),
    client.app.agents().catch(() => undefined),
    client.config.get().catch(() => undefined),
  ])
  return {
    providerList: pRes?.data,
    agents: aRes?.data,
    configModel: cRes?.data?.model,
  }
}

export interface ChatConnectionDeps {
  readonly bridge: ServerBridge
  /** The project's trust, asked with ADE's dialog if it is not given yet (`admitProject`). */
  readonly admit: (directory: string) => Promise<{ ok: true } | { ok: false; problem?: string }>
  /** The clock for `FRESH_MS`; the tests pass their own. */
  readonly now?: () => number
}

export type ChatConnection =
  | {
      ok: true
      client: NikcliClient
      directory: string
      /** The client's own `fetch`, bound to the folder and its trust: for the event stream (`stream.ts`). */
      fetch: typeof globalThis.fetch
    }
  | { ok: false; problem?: string }

/** A request refused because the user no longer trusts the project: not to be retried. */
export class ChatRefused extends Error {
  override readonly name = "ChatRefused"
}

/** Whether `error` is, or was caused by, a `ChatRefused`: the SDK wraps what `fetch` throws. */
export function isChatRefused(error: unknown): boolean {
  for (let at = error, depth = 0; at instanceof Error && depth < 5; at = at.cause, depth++) {
    if (at instanceof ChatRefused) return true
  }
  return false
}

const same = (a: string, b: string) => a.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === b.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()

function named(request: Request): string[] {
  const names: string[] = []
  const header = request.headers.get("x-nikcli-directory")
  if (header !== null) {
    try {
      names.push(decodeURIComponent(header))
    } catch {
      names.push(header)
    }
  }
  for (const value of new URL(request.url).searchParams.getAll("directory")) names.push(value)
  return names
}

/** A `fetch` that only lets through requests for `directory`, or for none. */
export function boundFetch(fetch: typeof globalThis.fetch, directory: string): typeof globalThis.fetch {
  const bound = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const other = named(request).find((name) => !same(name, directory))
    if (other !== undefined) {
      throw new TypeError(t("chat.error.otherFolder", directory, other))
    }
    return fetch(request)
  }
  return Object.assign(bound, { preconnect: () => {} }) as typeof globalThis.fetch
}

/** How long a yes to the project holds before the next request checks again. */
export const FRESH_MS = 2000

/** `fetch`, with the project's trust checked again before each request; closed for good after a no. */
function trustedFetch(
  fetch: typeof globalThis.fetch,
  directory: string,
  admit: ChatConnectionDeps["admit"],
  now: () => number,
): typeof globalThis.fetch {
  let refused: string | undefined
  let trustedAt = Number.NEGATIVE_INFINITY
  let pending: ReturnType<ChatConnectionDeps["admit"]> | undefined
  const trusted = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (refused === undefined && now() - trustedAt >= FRESH_MS) {
      pending ??= admit(directory).finally(() => (pending = undefined))
      const again = await pending
      if (again.ok) trustedAt = now()
      else if (again.problem !== undefined) refused = again.problem
      else throw new TypeError(t("chat.trustPending", directory))
    }
    if (refused !== undefined) throw new ChatRefused(refused)
    return fetch(input, init)
  }
  return Object.assign(trusted, { preconnect: () => {} }) as typeof globalThis.fetch
}

/** The client for `directory`, once its project is admitted; nothing is sent before. */
export async function openChat(directory: string, deps: ChatConnectionDeps): Promise<ChatConnection> {
  const admitted = await deps.admit(directory)
  if (!admitted.ok) return admitted.problem === undefined ? { ok: false } : { ok: false, problem: admitted.problem }
  const fetch = boundFetch(trustedFetch(serverFetch(deps.bridge, { directory }), directory, deps.admit, deps.now ?? Date.now), directory)
  const client = createNikcliClient({ baseUrl: SERVER_BASE, fetch, directory, throwOnError: true })
  return { ok: true, client, directory, fetch }
}

/** In the app: the Rust bridge, and the Bots' own trust in the project, with ADE's dialog. */
export function appChatConnectionDeps(): ChatConnectionDeps {
  return {
    bridge: tauriServerBridge(),
    admit: (directory) =>
      admitProject(directory, {
        store: localTrustStore(PROJECT_TRUST_KEY),
        surface: () => projectSurface(directory, projectFs),
        confirm: (question) => askDialog(question, { ok: t("bots.ask.yes"), cancel: t("bots.ask.no") }),
      }),
  }
}
