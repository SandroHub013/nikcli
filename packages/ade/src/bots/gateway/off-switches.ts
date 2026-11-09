/**
 * The ways a gateway goes off from ADE, which reach both sides: Rust halts the link and the page stops what it had
 * queued or running for it (BOT-2). Apart from `bridge.ts`, which needs the whole app, so that the second half is tested.
 */

import type { GatewayController } from "./controller"

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>
type Live = () => Pick<GatewayController, "off" | "revoke"> | undefined

export function offSwitches(invoke: Invoke, live: Live) {
  return {
    clearToken: async (bot: string, platform: string) => {
      try {
        await invoke("gateway_clear_token", { bot, platform })
      } finally {
        // Rust halts the link before it touches the keychain: no token, no gateway, so what it had queued or
        // running here stops whether or not the clearing succeeded (BOT-2).
        live()?.off(bot, platform)
      }
    },
    setEnabled: async (bot: string, platform: string, enabled: boolean, project?: string) => {
      try {
        await invoke("gateway_set_enabled", { bot, platform, enabled, project: project ?? null })
      } finally {
        // «Off» is a kill switch: Rust dropped its pending store, and the queued and running turns here stop (BOT-2).
        if (!enabled) live()?.off(bot, platform)
      }
    },
    pairingRevoke: async (bot: string, platform: string, sender: string) => {
      await invoke("gateway_pairing_revoke", { bot, platform, sender })
      // Rust no longer hears the sender; what was already queued here stops too.
      live()?.revoke(bot, platform, sender)
    },
  }
}

/**
 * A bot deleted: Rust stops its links before it touches the keychain, so what the page had queued or running for them
 * stops whether or not the clearing succeeded (BOT-2).
 */
export async function forgetBotGateways(invoke: Invoke, bot: string, switchOff: () => void | Promise<void>): Promise<void> {
  try {
    await invoke("gateway_forget_bot", { bot })
  } finally {
    await switchOff()
  }
}
