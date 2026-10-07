/**
 * The two places where one learns, as the world's rules see them: the Faro (the lessons) and the games' kiosk.
 * What a click or `E` presses there, what stops the character, and the words of the hint. Where they stand is
 * `layout.ts`'s; how they look is `places-view.ts`'s.
 *
 * Pressing one sends `{ cmd: "open-learn", place }` and nothing else: ADE opens the page over the world and
 * pauses it.
 */

import type { LearnPlace } from "../protocol"
import type { PlacePickable } from "./interaction"
import { FARO_DOOR, faroBoxes, faroWalls, kioskBoxes, kioskSpot, type Box } from "./layout"

/** The Faro's door and the kiosk's counter, as targets for the click and for `E`. */
export function placePickables(): PlacePickable[] {
  return [
    { kind: "place", place: "faro", x: FARO_DOOR.x, y: FARO_DOOR.y, z: FARO_DOOR.z, radius: FARO_DOOR.radius },
    { kind: "place", place: "gioco", ...kioskSpot() },
  ]
}

/** What stops the character at the two places: the tower and its rails, the kiosk's counter and posts. */
export const placeBoxes = (): Box[] => [...faroBoxes(), ...kioskBoxes()]

/** The walls a click cannot see through: the tower. The kiosk's counter is the target, its posts are thin. */
export const placeWalls = (): Box[] => faroWalls()

export type WorldLang = "it" | "en"

/** The hint within reach, as for a computer: the key, then what it does. */
const LABELS: Record<WorldLang, Record<LearnPlace, string>> = {
  it: { faro: "E · Lezioni", gioco: "E · Gioca" },
  en: { faro: "E · Lessons", gioco: "E · Play" },
}

/** What the kiosk's sign says. */
const SIGNS: Record<WorldLang, string> = { it: "GIOCA", en: "PLAY" }

export const placeLabel = (place: LearnPlace, lang: WorldLang): string => LABELS[lang][place]
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
