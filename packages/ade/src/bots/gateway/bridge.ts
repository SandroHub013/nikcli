/**
 * The gateways' controller in the app: the Rust commands and event over Tauri,
 * and the real turns, trust and sessions (G4).
 */

import { projectSurface, PROJECT_TRUST_KEY } from "../project-trust"
import { projectFs, readBotText, resolveRoots } from "../store"
import { localTrustStore } from "../trust"
import { runTurn } from "../turn"
import { startGatewayController, type GatewayBridge, type GatewayController, type GatewayMessage } from "./controller"
import { recheckTrust } from "./policy"
import { localSessionStore } from "./session"

interface LinkStatus {
  readonly bot: string
  readonly platform: string
  readonly project?: string | null
}

export function tauriGatewayBridge(): GatewayBridge {
  const invoke = async <T>(command: string, args?: Record<string, unknown>) =>
    (await import("@tauri-apps/api/core")).invoke<T>(command, args)
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

/** Starts listening for the chats' messages; the gateways read from then on. */
export function startAppGatewayController(): Promise<GatewayController> {
  return startGatewayController({
    bridge: tauriGatewayBridge(),
    runTurn: (request) => runTurn(request),
    loadBot: async (path, project) =>
      recheckTrust(path, project, {
        bots: localTrustStore(),
        projects: localTrustStore(PROJECT_TRUST_KEY),
        read: readBotText,
        surface: () => projectSurface(project, projectFs),
        globalRoot: (await resolveRoots()).global,
      }),
    sessions: localSessionStore(),
  })
}
