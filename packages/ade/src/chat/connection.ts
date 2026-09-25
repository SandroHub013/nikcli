/**
 * The chat's way to a project on the nikcli server (C2).
 *
 * A request with a directory makes the server load that folder's `.nikcli/`,
 * plugins included, which run as code; with the user's shared service, in a
 * process ADE does not control. So a folder is admitted first, as the Bots
 * are (B3b, `project-trust.ts`): the same fingerprint, the same yes kept in
 * the same place. Until then no request leaves, the server's start included
 * (ADE's own server would start in that folder); after a no, none ever does
 * for it (C1 review, M1).
 *
 * The client handed back is bound to that one folder: a request that names
 * another one, in the header or the query, is refused here, so the SDK's
 * per-call `directory` cannot reach a folder nobody said yes to.
 */

import { createNikcliClient, type NikcliClient } from "@nikcli-ai/sdk/client"
import { t } from "../i18n"
import { askDialog } from "../host/ask"
import { admitProject, PROJECT_TRUST_KEY, projectSurface } from "../bots/project-trust"
import { projectFs } from "../bots/store"
import { localTrustStore } from "../bots/trust"
import { SERVER_BASE, serverFetch, tauriServerBridge, type ServerBridge } from "./transport"

export interface ChatConnectionDeps {
  readonly bridge: ServerBridge
  /** The project's trust, asked with ADE's dialog if it is not given yet (`admitProject`). */
  readonly admit: (directory: string) => Promise<{ ok: true } | { ok: false; problem?: string }>
}

export type ChatConnection = { ok: true; client: NikcliClient; directory: string } | { ok: false; problem?: string }

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
      throw new TypeError(`La chat è aperta su ${directory}: una richiesta per ${other} non parte.`)
    }
    return fetch(request)
  }
  return Object.assign(bound, { preconnect: () => {} }) as typeof globalThis.fetch
}

/** The client for `directory`, once its project is admitted; nothing is sent before. */
export async function openChat(directory: string, deps: ChatConnectionDeps): Promise<ChatConnection> {
  const admitted = await deps.admit(directory)
  if (!admitted.ok) return admitted.problem === undefined ? { ok: false } : { ok: false, problem: admitted.problem }
  const client = createNikcliClient({
    baseUrl: SERVER_BASE,
    fetch: boundFetch(serverFetch(deps.bridge, { directory }), directory),
    directory,
    throwOnError: true,
  })
  return { ok: true, client, directory }
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
