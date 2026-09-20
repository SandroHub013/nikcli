import type { ReplyVoice } from "./model";
import { t, type Locale } from "@nikcli-ai/ade/i18n";

/**
 * D19, in the user's words: «ugo per maschile, e piper per femminile,
 * selezionabile dalle impostazioni». Each Piper voice states its licence where
 * it is chosen: both derive from the English lessac voice, whose dataset is
 * licensed for research only.
 */
export const REPLY_VOICE_CHOICES: readonly {
  value: ReplyVoice;
  title: string;
  desc: string;
  licence?: string;
}[] = [
  {
    value: "ugo",
    get title() {
      return t("vui.reply.male");
    },
    get desc() {
      return t("vui.reply.ugo");
    },
    get licence() {
      return t("vui.reply.ugo.licence");
    },
  },
  {
    value: "paola",
    get title() {
      return t("vui.reply.female");
    },
    get desc() {
      return t("vui.reply.paola");
    },
    get licence() {
      return t("vui.reply.paola.licence");
    },
  },
  {
    value: "lessac",
    get title() {
      return t("vui.reply.lessac.title");
    },
    get desc() {
      return t("vui.reply.lessac.desc");
    },
    get licence() {
      return t("vui.reply.lessac.licence");
    },
  },
  {
    value: "system",
    get title() {
      return t("vui.reply.system");
    },
    get desc() {
      return t("vui.reply.system.desc");
    },
  },
];

const PIPER_BY_LOCALE: Record<Locale, ReadonlySet<ReplyVoice>> = {
  it: new Set<ReplyVoice>(["ugo", "paola"]),
  en: new Set<ReplyVoice>(["lessac"]),
};

/** Voices the panel may offer for the interface language: matching Piper voices, plus system. */
export function replyVoiceChoicesForLocale(
  language: Locale,
): (typeof REPLY_VOICE_CHOICES)[number][] {
  const piper = PIPER_BY_LOCALE[language];
  return REPLY_VOICE_CHOICES.filter(
    (choice) => choice.value === "system" || piper.has(choice.value),
  );
}

/**
 * The Piper (or system) voice that actually speaks for `chosen` in `language`.
 *
 * A stored id from the other language is remapped so speech and the panel
 * agree; the catalog still holds every id, the panel just does not offer the
 * ones that would do nothing.
 */
export function activeReplyVoice(
  chosen: ReplyVoice,
  language: Locale,
): ReplyVoice {
  if (chosen === "system") return "system";
  if (language === "en")
    return chosen === "ugo" || chosen === "paola" ? "lessac" : chosen;
  return chosen === "lessac" ? "ugo" : chosen;
}
