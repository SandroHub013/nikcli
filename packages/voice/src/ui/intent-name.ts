/**
 * A voice command's name in the interface language, for the Comandi page.
 *
 * The intent's id (`session.new`) stays the key the parser and the logs use;
 * the page shows this name and puts the id beside it, small.
 */

import { t, type MessageKey } from "@nikcli-ai/ade/i18n"

export function intentName(intent: string): string {
  return t(`vui.intent.${intent}` as MessageKey & `vui.intent.${string}`)
}
