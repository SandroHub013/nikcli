/**
 * A file that is not text, as the host describes it.
 *
 * `read_text_file` refuses such a file with a structured failure rather than a
 * sentence: `{ kind: "binary", bytes, modified, head }`. The pane draws its card
 * from those fields; nothing here matches the text of an error.
 */

/** What the host knows about a binary file without reading it. */
export interface BinaryFile {
  /** The whole file's size. */
  bytes: number
  /** Last modification, in milliseconds since the epoch, when the disk says. */
  modified?: number
  /** The first bytes, for telling the format from its magic number. */
  head: number[]
}

/**
 * The failure the host's `readTextFile` throws for a binary file.
 *
 * Its message is the sentence the other readers already skip on (the search,
 * the links of a session): to them a binary is still a read that failed.
 */
export class BinaryFileError extends Error {
  constructor(readonly binary: BinaryFile) {
    super(`file binario, ${binary.bytes} byte`)
    this.name = "BinaryFileError"
  }
}

/** The binary file behind a failed read, or `undefined` when the failure is anything else. */
export function binaryFromHost(error: unknown): BinaryFile | undefined {
  if (error instanceof BinaryFileError) return error.binary
  if (!error || typeof error !== "object" || error instanceof Error) return undefined
  const value = error as Record<string, unknown>
  if (value.kind !== "binary" || typeof value.bytes !== "number") return undefined
  return {
    bytes: value.bytes,
    ...(typeof value.modified === "number" ? { modified: value.modified } : {}),
    head: Array.isArray(value.head) ? value.head.filter((byte): byte is number => typeof byte === "number") : [],
  }
}

/** The formats the card can name; anything else is a plain binary. */
export type BinaryType =
  | "apk"
  | "aab"
  | "jar"
  | "zip"
  | "exe"
  | "dll"
  | "pdf"
  | "gzip"
  | "7z"
  | "rar"
  | "sqlite"
  | "wasm"
  | "elf"
  | "binary"

const startsWith = (head: readonly number[], magic: readonly number[]) =>
  head.length >= magic.length && magic.every((byte, i) => head[i] === byte)

const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0))

/** The formats with a magic number of their own. A ZIP and a PE are refined by the name below. */
const MAGIC: Array<[readonly number[], BinaryType]> = [
  [[0x50, 0x4b, 0x03, 0x04], "zip"],
  [[0x50, 0x4b, 0x05, 0x06], "zip"],
  [[0x50, 0x4b, 0x07, 0x08], "zip"],
  [ascii("MZ"), "exe"],
  [ascii("%PDF"), "pdf"],
  [[0x1f, 0x8b], "gzip"],
  [[0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], "7z"],
  [[...ascii("Rar!"), 0x1a, 0x07], "rar"],
  [[...ascii("SQLite format 3"), 0], "sqlite"],
  [[0x00, 0x61, 0x73, 0x6d], "wasm"],
  [[0x7f, ...ascii("ELF")], "elf"],
]

const EXTENSIONS: Record<string, BinaryType> = {
  apk: "apk",
  aab: "aab",
  jar: "jar",
  zip: "zip",
  exe: "exe",
  dll: "dll",
  pdf: "pdf",
  gz: "gzip",
  tgz: "gzip",
  "7z": "7z",
  rar: "rar",
  sqlite: "sqlite",
  sqlite3: "sqlite",
  db: "sqlite",
  wasm: "wasm",
  so: "elf",
}

/** The ZIP-built formats a name can say a ZIP is, and the PE ones. */
const ZIP_FAMILY = new Set<BinaryType>(["apk", "aab", "jar", "zip"])
const PE_FAMILY = new Set<BinaryType>(["exe", "dll"])

function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
}

/**
 * What a binary file is: its first bytes first, its name to refine them.
 *
 * An APK, an AAB and a JAR are ZIPs inside, so the magic number says ZIP and
 * the extension says which; a name that contradicts the bytes loses.
 */
export function binaryType(path: string, head: readonly number[]): BinaryType {
  const byName = EXTENSIONS[extensionOf(path)]
  const byMagic = MAGIC.find(([magic]) => startsWith(head, magic))?.[1]
  if (byMagic === "zip") return byName && ZIP_FAMILY.has(byName) ? byName : "zip"
  if (byMagic === "exe") return byName && PE_FAMILY.has(byName) ? byName : "exe"
  return byMagic ?? byName ?? "binary"
}

/** Whether ADE can list what the file holds: the ZIP-built formats. */
export function isArchive(type: BinaryType): boolean {
  return ZIP_FAMILY.has(type)
}

const UNITS = ["KB", "MB", "GB", "TB"]

/**
 * A size as a person says it: `129,5 MB` in Italian, `129.5 MB` in English.
 *
 * Powers of 1024, as the file managers on Windows count, so the number matches
 * what Explorer shows for the same file.
 */
export function formatSize(bytes: number, language: "it" | "en"): string {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    const whole = Math.max(0, Math.round(Number.isFinite(bytes) ? bytes : 0))
    return language === "it" ? `${whole} byte` : `${whole} ${whole === 1 ? "byte" : "bytes"}`
  }
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  const number = new Intl.NumberFormat(language === "it" ? "it-IT" : "en-US", { maximumFractionDigits: 1 }).format(
    value,
  )
  return `${number} ${UNITS[unit]}`
}
