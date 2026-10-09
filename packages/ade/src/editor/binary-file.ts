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
