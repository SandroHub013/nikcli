import { For, Show } from "solid-js"
import { t } from "../i18n"
import { knownPermissions } from "./api"
import { unknownPermissions } from "./grants"
import { formatSize, permissionText } from "./words"

/**
 * The confirmation before a plugin is installed, in ADE's own DOM: its name and version, what it weighs, and what it may do in plain words.
 * Never in the plugin's frame, which cannot be trusted to ask about itself. What is read here comes from the signed manifest, not from
 * anything the plugin says.
 */
export function InstallConfirm(props: {
  name: string
  version: string
  sizeBytes: number
  /** The manifest's permissions, as it names them. */
  permissions: string[]
  onConfirm: () => void
  onCancel: () => void
}) {
  const known = () => knownPermissions(props.permissions)
  const unknown = () => unknownPermissions(props.permissions)
  return (
    <div data-slot="frame-plugin-confirm" role="alertdialog" aria-label={t("plugin.confirm.title", props.name, props.version)}>
      <p data-slot="frame-plugin-confirm-title">{t("plugin.confirm.title", props.name, props.version)}</p>
      <p data-slot="frame-plugin-confirm-size">{t("plugin.confirm.size", formatSize(props.sizeBytes))}</p>
      <Show when={known().length > 0} fallback={<p data-slot="frame-plugin-confirm-none">{t("plugin.confirm.none")}</p>}>
        <p>{t("plugin.confirm.asks")}</p>
        <ul data-slot="frame-plugin-confirm-permissions">
          <For each={known()}>{(permission) => <li>{permissionText(permission)}</li>}</For>
        </ul>
      </Show>
      <Show when={unknown().length > 0}>
        <p data-slot="frame-plugin-confirm-unknown">{t("plugin.confirm.unknown", unknown().join(", "))}</p>
      </Show>
      <div data-slot="frame-plugin-confirm-actions">
        <button type="button" data-slot="settings-choice" data-frame-plugin="confirm-install" data-active="true" onClick={props.onConfirm}>
          {t("plugin.confirm.install")}
        </button>
        <button type="button" data-slot="settings-choice" data-frame-plugin="confirm-cancel" onClick={props.onCancel}>
          {t("plugin.confirm.cancel")}
        </button>
      </div>
    </div>
  )
}
