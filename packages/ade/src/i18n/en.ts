import type { Messages } from "./it"

/**
 * ADE's texts in English.
 *
 * Written as product copy, not as a gloss of the Italian: the same meaning,
 * in the words an English-language app would use for it.
 */
export const en: Messages = {
  "settings.language.label": "Language",
  "settings.language.title": "Language",
  "settings.language.desc":
    "The language of ADE's menus, panels and notices. System follows your computer's language. The voice assistant keeps using the speech-recognition language, which you set in the voice settings.",
  "settings.language.group": "Interface language",
  "settings.language.system": "System",
  "settings.language.systemNow": (language) => `System (${language})`,
  "settings.language.it": "Italiano",
  "settings.language.en": "English",
}
