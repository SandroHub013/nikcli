/**
 * The brand (`brand.json`) and what the two Tauri configs must carry from it.
 *
 * Tauri's config is plain JSON with no variables, so the name, the publisher,
 * the copyright and the descriptions would otherwise be typed in several
 * places and hunted down at every rename. Here they are derived:
 * `bun run brand` (script/brand.ts) writes them, and `brand.test.ts` runs the
 * check so a hand edit of the config cannot silently outlive the brand.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export interface Brand {
  readonly name: string
  readonly publisher: string
  readonly since: number
  readonly tagline: string
  readonly description: string
  readonly homepage: string
}

const ROOT = join(import.meta.dir, "..")
export const BRAND_FILE = join(ROOT, "brand.json")
const CONFIGS = {
  main: join(ROOT, "src-tauri", "tauri.conf.json"),
  test: join(ROOT, "src-tauri", "tauri.test.conf.json"),
} as const

export function readBrand(path = BRAND_FILE): Brand {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Brand>
  for (const key of ["name", "publisher", "since", "tagline", "description", "homepage"] as const) {
    if (raw[key] === undefined || raw[key] === "") throw new Error(`brand.json: missing "${key}"`)
  }
  return raw as Brand
}

/** The year span of the copyright line: "2025" the first year, "2025-2026" after. */
export function copyrightLine(brand: Brand, year = new Date().getFullYear()): string {
  const span = year > brand.since ? `${brand.since}-${year}` : `${brand.since}`
  return `© ${span} ${brand.publisher}`
}

/** What each config must carry, as flat "a.b.c" paths. */
export function derived(brand: Brand, year?: number): Record<keyof typeof CONFIGS, Record<string, string>> {
  return {
    main: {
      productName: brand.name,
      "bundle.publisher": brand.publisher,
      "bundle.copyright": copyrightLine(brand, year),
      "bundle.homepage": brand.homepage,
      "bundle.shortDescription": brand.tagline,
      "bundle.longDescription": brand.description,
    },
    test: {
      productName: `${brand.name} Test`,
    },
  }
}

type Json = Record<string, unknown>

function get(object: Json, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => (node && typeof node === "object" ? (node as Json)[key] : undefined), object)
}

function set(object: Json, path: string, value: string): void {
  const keys = path.split(".")
  let node = object
  for (const key of keys.slice(0, -1)) {
    if (typeof node[key] !== "object" || node[key] === null) node[key] = {}
    node = node[key] as Json
  }
  node[keys[keys.length - 1]!] = value
}

/** Every path whose value in `config` is not what the brand says. */
export function drift(config: Json, wanted: Record<string, string>): string[] {
  return Object.entries(wanted)
    .filter(([path, value]) => get(config, path) !== value)
    .map(([path, value]) => `${path}: ${JSON.stringify(get(config, path))} → ${JSON.stringify(value)}`)
}

export function checkConfigs(brand = readBrand(), year?: number): string[] {
  const wanted = derived(brand, year)
  const problems: string[] = []
  for (const which of Object.keys(CONFIGS) as (keyof typeof CONFIGS)[]) {
    const config = JSON.parse(readFileSync(CONFIGS[which], "utf8")) as Json
    for (const line of drift(config, wanted[which])) problems.push(`${CONFIGS[which]}: ${line}`)
  }
  return problems
}

export function applyBrand(brand = readBrand()): void {
  const wanted = derived(brand)
  for (const which of Object.keys(CONFIGS) as (keyof typeof CONFIGS)[]) {
    const config = JSON.parse(readFileSync(CONFIGS[which], "utf8")) as Json
    for (const [path, value] of Object.entries(wanted[which])) set(config, path, value)
    writeFileSync(CONFIGS[which], `${JSON.stringify(config, null, 2)}\n`)
    console.log(`${CONFIGS[which]}: ${Object.keys(wanted[which]).length} fields from brand.json`)
  }
}
