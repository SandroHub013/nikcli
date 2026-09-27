import type { ChipMenuItem } from "../chat/picker"
import type { BotChanges } from "./store"

/**
 * Sending what is in a bot's composer.
 *
 * The composer is cleared at once, so a message is not sent twice by a
 * second Enter while the first is on its way. What did not go comes back:
 * a trust question already open, a «no» to it, a bot that refuses to start
 * or a turn still running (B3-bis, review B3, BASSO 3) — unless something
 * new was typed meanwhile, which is not overwritten.
 */
export async function submitDraft(
  text: string,
  send: (text: string) => boolean | Promise<boolean>,
  draft: { get: () => string; set: (text: string) => void },
): Promise<void> {
  draft.set("")
  let sent = false
  try {
    sent = await send(text)
  } catch {
    sent = false
  }
  if (!sent && draft.get().trim().length === 0) draft.set(text)
}

/*
 * The composer's chips (composer-chip, pezzo 4): the model and the effort
 * chosen under the field change the bot, with the form's save (`updateBot`).
 * These say what each choice writes; the chips only call them.
 */

/**
 * What choosing a model writes. The effort goes with it when the new model
 * does not have it: the form showed «predefinito» over such a level and saved
 * it as none (`effortToSave`), and so does the chip. Variants not known (a
 * catalog not read, another runner) leave the effort as it is.
 */
export function modelChange(model: string, effort: string, variants: readonly string[] | undefined): BotChanges {
  const value = model.trim()
  const level = effort.trim()
  const drop = level.length > 0 && variants !== undefined && !variants.includes(level)
  return { model: value || undefined, ...(drop ? { effort: undefined } : {}) }
}

/** What choosing an effort writes: the default is none. */
export function effortChange(effort: string): BotChanges {
  return { effort: effort.trim() || undefined }
}

/**
 * The model chip's list for Claude Code and Codex: their default first, the
 * names the runner suggests, and the bot's own when the list lacks it. Their
 * CLIs take a name the list does not know, so the chip keeps it as it is.
 */
export function runnerModelItems(
  models: readonly string[],
  value: string,
  defaultLabel: string,
): readonly ChipMenuItem[] {
  const own = value.trim()
  return [
    { kind: "option", value: "", label: defaultLabel },
    ...models.map((id): ChipMenuItem => ({ kind: "option", value: id, label: id })),
    ...(own && !models.includes(own) ? [{ kind: "option", value: own, label: own } as const] : []),
  ]
}
