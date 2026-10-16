import { createResource, For, Show } from "solid-js"
import { t } from "../i18n"
import { offersRemoteCommands, remoteKey, remoteTools, type RemoteStore } from "./gateway/remote"
import { conversationText, phoneText, remoteNeverKey, routinesTextKey } from "./permissions-facts"
import type { AgentFile } from "./ragu"
import { runnerById } from "./runners"

const PLATFORMS = [
  { id: "telegram", label: () => t("gateway.panel.platformTelegram") },
  { id: "discord", label: () => t("gateway.panel.platformDiscord") },
  { id: "slack", label: () => t("gateway.panel.platformSlack") },
] as const

/**
 * The Permissions tab (scelta 1, 7): what the bot can do from a phone and in a
 * routine, and what exists on permissions today. The list of the «Always» the
 * user gave, and the way to take them back, are the next lot (scelta 4): they
 * are not here on purpose.
 */
export function PermissionsSection(props: {
  bot: AgentFile
  /** Where the remote commands' switch is kept; absent where there are no platforms. */
  remote?: RemoteStore
  /** The fingerprint of the bot's file as it is now: the gateway compares the switch with it on every turn. */
  fingerprintOf?: (bot: AgentFile) => Promise<string | undefined>
}) {
  const runner = () => runnerById(props.bot.runner)
  const phone = () => phoneText(props.bot)
  const conversation = () => conversationText(props.bot)
  // The same check as a chat's turn (`remoteTools`): a switch saved for another version of the file is off.
  const [fingerprint] = createResource(
    () => props.bot,
    async (bot) => {
      try {
        return await props.fingerprintOf?.(bot)
      } catch {
        return undefined
      }
    },
  )
  const stateOf = (platform: string) => {
    const setting = props.remote?.get(remoteKey(props.bot.path, platform))
    if (remoteTools(setting, fingerprint()).commands) return "on"
    return setting?.commands && !fingerprint.loading ? "stale" : "off"
  }
  return (
    <div data-slot="bots-tab-body" data-tab="permissions">
      {/* From a phone: only where there are messaging apps (not in the official build yet). */}
      <Show when={props.remote !== undefined}>
        <section data-slot="bots-section" aria-labelledby="bots-permissions-phone">
          <h3 data-slot="bots-section-title" id="bots-permissions-phone">
            {t("bots.permissions.phone")}
          </h3>
          <p data-slot="bots-hint">{t(phone().key)}</p>
          <p data-slot="bots-hint">{phone().edits ? t("bots.permissions.edits") : t("bots.permissions.noEdits")}</p>
          <Show
            when={offersRemoteCommands(props.bot.runner)}
            fallback={<p data-slot="bots-hint">{t(remoteNeverKey(props.bot), runner().label)}</p>}
          >
            <ul data-slot="gateway-list">
              <For each={PLATFORMS}>
                {(platform) => (
                  <li>
                    {stateOf(platform.id) === "on"
                      ? t("bots.permissions.remoteOn", platform.label())
                      : stateOf(platform.id) === "stale"
                        ? t("bots.permissions.remoteStale", platform.label())
                        : t("bots.permissions.remoteOff", platform.label())}
                  </li>
                )}
              </For>
            </ul>
            <p data-slot="bots-hint">{t("bots.permissions.remoteHow")}</p>
          </Show>
        </section>
      </Show>

      <section data-slot="bots-section" aria-labelledby="bots-permissions-routines">
        <h3 data-slot="bots-section-title" id="bots-permissions-routines">
          {t("bots.permissions.routines")}
        </h3>
        <p data-slot="bots-hint">{t(routinesTextKey(props.bot))}</p>
      </section>

      <section data-slot="bots-section" aria-labelledby="bots-permissions-panel">
        <h3 data-slot="bots-section-title" id="bots-permissions-panel">
          {t("bots.permissions.panel")}
        </h3>
        <p data-slot="bots-hint">{t(conversation().key)}</p>
        <p data-slot="bots-hint">
          {conversation().edits ? t("bots.permissions.edits") : t("bots.permissions.noEdits")}
        </p>
      </section>

      <section data-slot="bots-section" aria-labelledby="bots-permissions-trust">
        <h3 data-slot="bots-section-title" id="bots-permissions-trust">
          {t("bots.permissions.trust")}
        </h3>
        <p data-slot="bots-hint">{t("bots.permissions.trustText")}</p>
      </section>
    </div>
  )
}
