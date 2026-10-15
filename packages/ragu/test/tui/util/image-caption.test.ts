import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { IMAGE_LOADING, IMAGE_OPENED, IMAGE_OPENING, imageCaption, imageOpenFailure } from "@tui/util/image-caption"

/*
 * Review of the UI, N11: the line over an image read «image | local file | ade | ctrl+x v: open full size» (the host
 * and the renderer are the machinery's names), «Cannot open image» was not in the error colour, and the dots were three.
 */
const source = readFileSync(join(import.meta.dir, "../../../../tui/src/component/tui-image.tsx"), "utf8")

describe("the caption of an image", () => {
  test("says it is an image and how to open it, with the key as the user bound it", () => {
    expect(imageCaption("ctrl+x v")).toBe("image · ctrl+x v to open")
    expect(imageCaption(undefined)).toBe("image · click to open")
  })

  test("carries no host or renderer name", () => {
    expect(source).not.toMatch(/data\(\)\.host|data\(\)\.renderer|"halfblock" :/)
    expect(source).toContain("imageCaption(props.openKey)")
  })

  test("the progress lines use «…»", () => {
    for (const text of [IMAGE_LOADING, IMAGE_OPENING]) {
      expect(text.endsWith("…")).toBe(true)
      expect(text).not.toContain("...")
    }
    expect(IMAGE_OPENED).toBe("Opened in image viewer")
  })
})

describe("an image that cannot be opened", () => {
  test("says why, and is drawn in the error colour", () => {
    expect(imageOpenFailure(new Error("no viewer"))).toBe("Cannot open image: no viewer")
    expect(imageOpenFailure("gone")).toBe("Cannot open image: gone")
    expect(source).toContain("openFailed() ? theme.status.error.fg")
  })
})
