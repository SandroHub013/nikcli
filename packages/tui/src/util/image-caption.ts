/**
 * The line over an image in the transcript. It used to carry the host, the renderer and the key as
 * «image | local file | ade | ctrl+x v: open full size»: names of the machinery, not of anything the reader can act on.
 */
export function imageCaption(openKey?: string): string {
  return `image · ${openKey || "click"} to open`
}

/** What the open-image line says while it works, and when it is done. «…», never three dots. */
export const IMAGE_OPENING = "Opening full-resolution image…"
export const IMAGE_OPENED = "Opened in image viewer"
export const IMAGE_LOADING = "Loading image preview…"

export function imageOpenFailure(error: unknown): string {
  return `Cannot open image: ${error instanceof Error ? error.message : String(error)}`
}
