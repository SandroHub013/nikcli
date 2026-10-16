/**
 * A bot's face: a shape and a colour, and where its eyes are looking.
 *
 * A roster of grey circles with an initial in each is a list of names. The
 * thing that makes a bot recognisable at a glance — before the name is read —
 * is a silhouette that is always the same for that bot and different from the
 * others. So each bot gets one of nine shapes in one of six colours, derived
 * from its identifier: the file `revisore.md` is a magenta circle on every
 * machine, in the roster, in the thread and in the sidebar, with nothing
 * written down anywhere. A field in the frontmatter would be a second thing
 * to keep in step with the first, and ragu would not know what it was for.
 *
 * The colours are ADE's own ANSI palette, so they follow the theme: the
 * component sets `--bot-color: var(--ade-ansi-<name>)` and the light values
 * are picked by the stylesheet, not here.
 *
 * Pure, in a `.ts`, because a wrong hash is a bot that changes shape between
 * two builds, which is worse than any shape being ugly.
 */

export const SHAPES = ["circle", "drop", "cloud", "hex", "egg", "pill", "tri", "square", "blob"] as const
export type Shape = (typeof SHAPES)[number]

export const COLORS = ["magenta", "blue", "green", "cyan", "yellow", "red"] as const
export type Color = (typeof COLORS)[number]

export interface Avatar {
  readonly shape: Shape
  readonly color: Color
}

/**
 * FNV-1a, 32 bit. Stable, cheap, and spreads short similar names — `bot1`,
 * `bot2` — onto different shapes, which is what the roster needs.
 */
export function hashIdentifier(identifier: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < identifier.length; i++) {
    hash ^= identifier.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * A face written down: `shape/color`, the form the agent file's `avatar` key
 * takes. ragu ignores keys it does not know, so the choice travels with the
 * file — a bot copied to another machine keeps its face.
 */
export function avatarKey(avatar: Avatar): string {
  return `${avatar.shape}/${avatar.color}`
}

/** The face a file names, or nothing when the key is absent or not a face. */
export function parseAvatar(value: string | undefined): Avatar | undefined {
  if (!value) return undefined
  const [shape, color] = value.trim().toLowerCase().split("/")
  if (!SHAPES.includes(shape as Shape) || !COLORS.includes(color as Color)) return undefined
  return { shape: shape as Shape, color: color as Color }
}

/** The face to draw: the one chosen, or the one the name gives. */
export function faceOf(identifier: string, chosen?: string): Avatar {
  return parseAvatar(chosen) ?? avatarFor(identifier)
}

export function avatarFor(identifier: string): Avatar {
  const hash = hashIdentifier(identifier.trim().toLowerCase())
  // Two independent slices of the hash, so shape and colour do not move
  // together: with 9 × 6 combinations the low bits alone would pair them.
  const shape = SHAPES[hash % SHAPES.length]
  const color = COLORS[Math.floor(hash / 64) % COLORS.length]
  return { shape, color }
}

/** «A caso»: a shape and a colour, two draws, written down like a face the user chose. */
export function randomAvatar(random: () => number = Math.random): Avatar {
  const shape = SHAPES[Math.min(SHAPES.length - 1, Math.floor(random() * SHAPES.length))]!
  const color = COLORS[Math.min(COLORS.length - 1, Math.floor(random() * COLORS.length))]!
  return { shape, color }
}

/*
 * «Carica un'immagine» (design/ade-bot-2, scelta 2). The picture is cut to a small square and written in the bot's own
 * file, as the `avatar` key, so whoever copies the bot has its face too and nothing is fetched from anywhere. Only a
 * raster image of three kinds is drawn: never an SVG (it can hold a script), never an address.
 */

/** The side of the square kept: twice the largest face drawn, for a sharp one on a dense screen. */
export const FACE_IMAGE_SIDE = 96
/** The longest `avatar` image kept in a file, in characters: a few kilobytes, so the file stays a text one reads. */
export const FACE_IMAGE_MAX_URL = 24_000

const FACE_IMAGE = /^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/

/** The picture a file names as its face, or nothing: a shape, an address or anything but a small raster image. */
export function parseFaceImage(value: string | undefined): string | undefined {
  if (!value || value.length > FACE_IMAGE_MAX_URL) return undefined
  return FACE_IMAGE.test(value) ? value : undefined
}

/** A PNG or a JPG, by its first bytes and not by its name; anything else is not taken. */
export function sniffFaceImage(bytes: Uint8Array): "png" | "jpeg" | undefined {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length >= png.length && png.every((byte, index) => bytes[index] === byte)) return "png"
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg"
  return undefined
}

/** The largest square in the middle of a picture. */
export function squareCrop(width: number, height: number): { x: number; y: number; side: number } {
  const side = Math.min(width, height)
  return { x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), side }
}

/**
 * What the eyes do.
 *
 * The same states a session has, with one more for a bot that cannot be
 * spoken to — a subagent, or one whose file is broken — whose eyes are
 * closed. The stylesheet moves the two strokes; nothing else changes, so the
 * face stays two strokes and never becomes a drawing.
 */
export type Expression = "still" | "busy" | "waiting" | "error" | "off"

export function expressionFor(status: "idle" | "working" | "waiting" | "error" | "off" | undefined): Expression {
  switch (status) {
    case "working":
      return "busy"
    case "waiting":
      return "waiting"
    case "error":
      return "error"
    case "off":
      return "off"
    default:
      return "still"
  }
}
