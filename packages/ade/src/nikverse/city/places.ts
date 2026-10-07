/**
 * The two places where one learns, as the world's rules see them: the Faro (the lessons) and the games' kiosk.
 * What stops the character there, and the language of the kiosk's sign. Where they stand is
 * `layout.ts`'s; how they look is `places-view.ts`'s.
 */

import { faroBoxes, faroWalls, kioskBoxes, type Box } from "./layout"

/** What stops the character at the two places: the tower and its rails, the kiosk's counter and posts. */
export const placeBoxes = (): Box[] => [...faroBoxes(), ...kioskBoxes()]

/** The walls a click cannot see through: the tower. The kiosk's counter is the target, its posts are thin. */
export const placeWalls = (): Box[] => faroWalls()

export type WorldLang = "it" | "en"

/** What the kiosk's sign says. */
const SIGNS: Record<WorldLang, string> = { it: "GIOCA", en: "PLAY" }

export const kioskSign = (lang: WorldLang): string => SIGNS[lang]

/**
 * The world's language: the one ADE names in the address (`?lang=`), else the system's by ADE's own rule
 * (`i18n/locale.ts`, `systemLocaleFrom`): Italian for an Italian system, English for any other.
 */
export function worldLang(asked: string | undefined, languages: readonly (string | undefined)[]): WorldLang {
  if (asked === "it" || asked === "en") return asked
  const first = languages.find((language) => typeof language === "string" && language.trim().length > 0)
  return first === undefined || first.trim().toLowerCase().startsWith("it") ? "it" : "en"
}
