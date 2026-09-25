import { t } from "../i18n"

/*
 * The yes/no question the Bot section puts before a project's bot, or a
 * project's nikcli configuration, runs (B3, B3b). Not `window.confirm`: in ADE
 * the dialog plugin replaces it with its `confirm` command, which this window
 * is not granted (`capabilities/default.json` has `dialog:allow-ask`), so it
 * rejected and no project bot ever started (B7, live in ADE Test).
 */

export interface AskOptions {
  readonly title: string
  readonly kind: "warning"
  readonly okLabel: string
  readonly cancelLabel: string
}

export type AskDialog = (message: string, options: AskOptions) => Promise<boolean>

export async function askUser(
  question: string,
  load: () => Promise<{ ask: AskDialog }> = () => import("@tauri-apps/plugin-dialog"),
): Promise<boolean> {
  const { ask } = await load()
  return ask(question, { title: "ADE", kind: "warning", okLabel: t("bots.ask.yes"), cancelLabel: t("bots.ask.no") })
}
