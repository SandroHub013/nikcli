/**
 * «Carica un'immagine» for a bot's face (design/ade-bot-2, scelta 2): a PNG or a JPG the user picks, cut to a square
 * in the middle and made small, as a `data:` image for the bot's file (`avatar.ts`).
 *
 * The file is picked with the page's own file field: the WebView reads that one file and nothing else, with no
 * permission of ADE's. Nothing leaves the computer and no model is asked. The rules are here, the drawing is the
 * browser's (`browserFaceImage`), so a test passes its own.
 */

import { t } from "../i18n"
import { FACE_IMAGE_SIDE, parseFaceImage, sniffFaceImage, squareCrop } from "./avatar"

/** The largest picture taken, in bytes: a photo from a phone, not a poster. */
export const FACE_IMAGE_MAX_INPUT = 5 * 1024 * 1024

/** The qualities tried in turn, until the image fits in `FACE_IMAGE_MAX_URL`. */
const QUALITIES = [0.85, 0.6] as const

export interface FaceBitmap {
  readonly width: number
  readonly height: number
  close?: () => void
}

export interface FaceImageDeps {
  /** Rejects when the bytes are not a picture after all. */
  decode: (blob: Blob) => Promise<FaceBitmap>
  /** The square cut of `image`, at `side` pixels, as a `data:` URL; undefined when it cannot be drawn. */
  encode: (
    image: FaceBitmap,
    crop: { x: number; y: number; side: number },
    side: number,
    quality: number,
  ) => string | undefined
}

export type FaceImageResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly problem: string }

export async function loadFaceImage(file: Blob, deps: FaceImageDeps): Promise<FaceImageResult> {
  if (file.size > FACE_IMAGE_MAX_INPUT)
    return { ok: false, problem: t("bots.face.problem.tooBig", FACE_IMAGE_MAX_INPUT / 1024 / 1024) }
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer())
  if (!sniffFaceImage(head)) return { ok: false, problem: t("bots.face.problem.format") }
  let image: FaceBitmap
  try {
    image = await deps.decode(file)
  } catch {
    return { ok: false, problem: t("bots.face.problem.unreadable") }
  }
  try {
    const crop = squareCrop(image.width, image.height)
    if (crop.side <= 0) return { ok: false, problem: t("bots.face.problem.unreadable") }
    for (const quality of QUALITIES) {
      const url = parseFaceImage(deps.encode(image, crop, FACE_IMAGE_SIDE, quality))
      if (url) return { ok: true, url }
    }
    return { ok: false, problem: t("bots.face.problem.heavy") }
  } finally {
    image.close?.()
  }
}

/** The WebView's own drawing: WebP, small and with its transparency (a canvas that cannot makes a PNG, still checked). */
export const browserFaceImage: FaceImageDeps = {
  decode: (blob) => createImageBitmap(blob),
  encode: (image, crop, side, quality) => {
    const canvas = document.createElement("canvas")
    canvas.width = side
    canvas.height = side
    const context = canvas.getContext("2d")
    if (!context) return undefined
    context.imageSmoothingQuality = "high"
    context.drawImage(image as ImageBitmap, crop.x, crop.y, crop.side, crop.side, 0, 0, side, side)
    return canvas.toDataURL("image/webp", quality)
  },
}
