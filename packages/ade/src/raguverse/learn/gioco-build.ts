/**
 * The levels of the game «Trova l'iniezione», read from their YAML and turned into the `gioco.json` the page is served.
 *
 * A level is a YAML file under `gioco/`, following `gioco/schema.json`. The page is plain JavaScript with no build, so it
 * cannot read YAML: what it is served is `gioco.json`. `gioco.test.ts` re-runs the conversion and fails if the committed JSON
 * drifts from the YAML sources.
 */

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export const GIOCO_VERSION = 1

export interface Riga {
  testo: string
  tipo: "normale" | "esca" | "iniezione"
  perche?: string
  travestimento?: string
  effetto?: string
  difesa?: string
}

export interface Livello {
  id: string
  versione: string
  lingua: string
  stato: string
  autori: { bozza: string; revisione?: string }
  livello: number
  tappa: "spiaggia" | "chiringuito" | "laguna" | "faro"
  difficolta: number
  secondi: number
  documento: string
  etichetta: string
  compito: string
  righe: Riga[]
  spiegazione: string
  fonti: string[]
}

export interface GiocoContent {
  v: number
  livelli: Livello[]
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Every YAML file in `root`, relative with forward slashes, in deterministic sorted order. */
export function giocoFiles(root: string, prefix = ""): string[] {
  const found: string[] = []
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) found.push(...giocoFiles(root, relative))
    else if (entry.name.endsWith(".yaml")) found.push(relative)
  }
  return found.sort(byText)
}

/** Parses one level from YAML text, verifying basic structure and review state. */
export function parseLivello(text: string, name: string): Livello {
  let parsed: unknown
  try {
    parsed = Bun.YAML.parse(text)
  } catch (error) {
    throw new Error(`${name}: YAML non valido: ${(error as Error).message}`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name}: il livello non è un documento`)
  }
  const level = parsed as Livello
  if (level.stato !== "rivista" && level.stato !== "pubblicata") {
    throw new Error(`${name}: stato ${String(level.stato)}: in gioco.json entra solo un livello rivisto`)
  }
  return level
}

/** Converts all YAML levels in `root` into `GiocoContent` ordered by level number. */
export function convertGioco(root: string): GiocoContent {
  const levels: Livello[] = []
  for (const file of giocoFiles(root)) {
    const level = parseLivello(readFileSync(join(root, file), "utf8"), file)
    levels.push(level)
  }
  return {
    v: GIOCO_VERSION,
    livelli: levels.sort((a, b) => a.livello - b.livello || byText(a.id, b.id)),
  }
}

/** JSON representation with 2-space indentation and trailing newline. */
export function toGiocoJson(content: GiocoContent): string {
  return `${JSON.stringify(content, null, 2)}\n`
}
