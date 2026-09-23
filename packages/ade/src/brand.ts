/**
 * The brand (`brand.json`) and what the two Tauri configs must carry from it.
 *
 * Tauri's config is plain JSON with no variables, so the name, the publisher,
 * the copyright and the descriptions would otherwise be typed in several
 * places and hunted down at every rename. Here they are derived:
 * `bun run brand` (script/brand.ts) writes them, and `brand.test.ts` checks
 * the configs so a hand edit cannot silently outlive the brand. The app
 * imports `BRAND` for the few places the name is shown outside the catalogs.
 *
 * Nothing here touches the calendar: the copyright's last year is a field
 * of brand.json, bumped when a release is cut, so no check goes red on its
 * own on the first of January.
 */
import brandJson from "../brand.json"

export interface Brand {
  readonly name: string
  readonly publisher: string
  readonly since: number
  readonly until: number
  readonly tagline: string
  readonly description: string
  readonly homepage: string
}

export function asBrand(raw: unknown): Brand {
  const value = (raw ?? {}) as Partial<Brand>
  for (const key of ["name", "publisher", "since", "until", "tagline", "description", "homepage"] as const) {
    if (value[key] === undefined || value[key] === "") throw new Error(`brand.json: missing "${key}"`)
  }
  if (value.until! < value.since!) throw new Error("brand.json: until is before since")
  return value as Brand
}

/** The brand as built into the app. */
export const BRAND: Brand = asBrand(brandJson)

/** The copyright line: "© 2025 nikcli" the first year, "© 2025-2026 nikcli" after. */
export function copyrightLine(brand: Brand): string {
  const span = brand.until > brand.since ? `${brand.since}-${brand.until}` : `${brand.since}`
  return `© ${span} ${brand.publisher}`
}

/** What each config must carry, as flat "a.b.c" paths. */
export function derived(brand: Brand): { main: Record<string, string>; test: Record<string, string> } {
  return {
    main: {
      productName: brand.name,
      "bundle.publisher": brand.publisher,
      "bundle.copyright": copyrightLine(brand),
      "bundle.homepage": brand.homepage,
      "bundle.shortDescription": brand.tagline,
      "bundle.longDescription": brand.description,
    },
    test: {
      productName: `${brand.name} Test`,
    },
  }
}

export type Json = Record<string, unknown>

export function get(object: Json, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => (node && typeof node === "object" ? (node as Json)[key] : undefined), object)
}

export function set(object: Json, path: string, value: string): void {
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
