/**
 * The gateways' controller in the app: the Rust commands and event over Tauri,
 * and the real turns, trust and sessions (G4). And the same for the panel in
 * a bot's card (G6).
 */

import { t } from "../../i18n"
import { askDialog } from "../../host/ask"
import type { AgentFile } from "../nikcli"
import { admitProject, projectSurface, PROJECT_TRUST_KEY } from "../project-trust"
import { runnerById } from "../runners"
import { localGatewayThreads, projectFs, readBotText, resolveRoots } from "../store"
import { admit, localTrustStore } from "../trust"
import { runBotTurn } from "../serve-turn"
import { startGatewayController, type GatewayBridge, type GatewayController, type GatewayMessage } from "./controller"
import type { GatewayPanelApi, GatewayPanelDeps, LinkStatus as LiveStatus, PairingRequest } from "./panel-state"
import { recheckTrust, scopeOf } from "./policy"
import { localAccountStore } from "../account"
import { localRemoteStore } from "./remote"
import { appMemoryStore } from "../memory-app"
import { localSessionStore } from "./session"

interface LinkStatus {
  readonly bot: string
  readonly platform: string
  readonly project?: string | null
}

const invoke = async <T>(command: string, args?: Record<string, unknown>) =>
  (await import("@tauri-apps/api/core")).invoke<T>(command, args)

export function tauriGatewayBridge(): GatewayBridge {
  return {
    async listen(onMessage) {
      const { listen } = await import("@tauri-apps/api/event")
      return listen<GatewayMessage>("gateway:message", (event) => onMessage(event.payload))
    },
    ready: () => invoke<void>("gateway_ready"),
    send: (bot, platform, chat, text) => invoke<string>("gateway_send", { bot, platform, chat, text, buttons: null }),
    sendButtons: (bot, platform, chat, text, buttons) => invoke<string>("gateway_send", { bot, platform, chat, text, buttons }),
    typing: (bot, platform, chat) => invoke<void>("gateway_typing", { bot, platform, chat }),
    async project(bot, platform) {
      const links = await invoke<LinkStatus[]>("gateway_status")
      return links.find((link) => link.bot === bot && link.platform === platform)?.project ?? undefined
    },
  }
}

/** The panel's side of the Rust commands. No command returns a token. */
export function tauriGatewayPanelApi(): GatewayPanelApi {
  return {
    status: () => invoke("gateway_status"),
    setToken: (bot, platform, token) => invoke("gateway_set_token", { bot, platform, token }),
    clearToken: (bot, platform) => invoke("gateway_clear_token", { bot, platform }),
    probe: (bot, platform) => invoke("gateway_probe", { bot, platform }),
    setEnabled: (bot, platform, enabled, project) => invoke("gateway_set_enabled", { bot, platform, enabled, project: project ?? null }),
    pairingList: (bot, platform) => invoke("gateway_pairing_list", { bot, platform }),
    pairingApprove: (bot, platform, code) => invoke("gateway_pairing_approve", { bot, platform, code }),
    pairingReject: (bot, platform, request) => invoke("gateway_pairing_reject", { bot, platform, request }),
    pairingRevoke: (bot, platform, sender) => invoke("gateway_pairing_revoke", { bot, platform, sender }),
    pairingOpen: (bot, platform) => invoke("gateway_pairing_open", { bot, platform }),
    async listen(handlers) {
      const { listen } = await import("@tauri-apps/api/event")
      const stops = await Promise.all([
        listen<LiveStatus>("gateway:status", (event) => handlers.status(event.payload)),
        listen<PairingRequest>("gateway:pairing", (event) => handlers.pairing(event.payload)),
        listen<GatewayMessage>("gateway:message", (event) => handlers.message(event.payload)),
      ])
      return () => stops.forEach((stop) => stop())
    },
  }
}

const askTrust = (question: string) => askDialog(question, { ok: t("bots.ask.yes"), cancel: t("bots.ask.no") })

/**
 * The trust a chat's turns need, asked now with ADE's dialogs (B3/B3b), then
 * checked exactly as every chat turn checks it; the bot is a repository's
 * unless its file is in nikcli's global folders (`scopeOf`), whatever the
 * roster said.
 */
export async function approveForChat(
  bot: AgentFile,
  project: string,
): Promise<{ ok: true; fingerprint: string } | { ok: false; problem?: string }> {
  const globalRoot = (await resolveRoots()).global
  const scoped: AgentFile = { ...bot, scope: scopeOf(bot.path, globalRoot) }
  const asked = await admit(scoped, { store: localTrustStore(), read: readBotText, confirm: askTrust })
  if (!asked.ok) return asked
  if (scoped.scope === "project" && runnerById(bot.runner).id === "nikcli") {
    const configuration = await admitProject(project, {
      store: localTrustStore(PROJECT_TRUST_KEY),
      surface: () => projectSurface(project, projectFs),
      confirm: askTrust,
    })
    if (!configuration.ok) return configuration
  }
  const checked = await recheckTrust(bot.path, project, {
    bots: localTrustStore(),
    projects: localTrustStore(PROJECT_TRUST_KEY),
    read: readBotText,
    surface: () => projectSurface(project, projectFs),
    globalRoot,
  })
  return checked.ok ? { ok: true, fingerprint: checked.fingerprint } : { ok: false, problem: checked.problem }
}

/** What the panel needs in the app, but the bot. */
export function appGatewayPanelDeps(project: () => string | undefined): Omit<GatewayPanelDeps, "bot"> {
  return {
    api: tauriGatewayPanelApi(),
    project,
    remote: localRemoteStore(),
    approve: approveForChat,
    confirm: (question) => askDialog(question, { ok: t("bots.ask.yes"), cancel: t("bots.ask.no") }),
  }
}

/** Starts listening for the chats' messages; the gateways read from then on. */
export function startAppGatewayController(): Promise<GatewayController> {
  return startGatewayController({
    bridge: tauriGatewayBridge(),
    runTurn: (request) => runBotTurn(request),
    loadBot: async (path, project) =>
      recheckTrust(path, project, {
        bots: localTrustStore(),
        projects: localTrustStore(PROJECT_TRUST_KEY),
        read: readBotText,
        surface: () => projectSurface(project, projectFs),
        globalRoot: (await resolveRoots()).global,
      }),
    sessions: localSessionStore(),
    threads: localGatewayThreads(),
    remote: (bot) => localRemoteStore().get(bot),
    account: (bot) => localAccountStore().get(bot),
    memory: appMemoryStore,
  })
}
