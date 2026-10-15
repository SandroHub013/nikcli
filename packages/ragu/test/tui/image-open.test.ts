import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { rgbaToPng } from "@ragu/tui-image"
import { localImagePath, openFullResolutionImage, prepareImageForOpen, readImageSource } from "@tui/util/image-open"

const png = rgbaToPng({ width: 1, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255]) })
const signal = () => new AbortController().signal
const response = (bytes = png) =>
  Object.assign(
    async () => new Response(new Uint8Array(bytes).buffer, { headers: { "content-type": "image/png" } }),
    { preconnect: fetch.preconnect },
  ) satisfies typeof fetch

describe("full-resolution image opening", () => {
  test("uses exact local bytes and converts Windows file URLs correctly", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "image-open-test-"))
    try {
      const filename = path.join(directory, "space & percent% image.png")
      await writeFile(filename, png)
      const prepared = await prepareImageForOpen(pathToFileURL(filename).href, signal())
      expect(prepared.filename).toBe(filename)
      expect(await readImageSource(filename, signal())).toEqual(new Uint8Array(png))
      await prepared.dispose()
      expect(await readFile(filename)).toEqual(Buffer.from(png))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("downloads unchanged bytes into a private cache and cleans it", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "image-open-test-"))
    try {
      const prepared = await prepareImageForOpen("https://example.com/a.png?x=%26whoami", signal(), {
        fetch: response(),
        cacheRoot: directory,
      })
      expect(await readFile(prepared.filename)).toEqual(Buffer.from(png))
      expect(path.extname(prepared.filename)).toBe(".png")
      await prepared.dispose()
      expect(await readdir(directory)).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("passes only a validated local file to the launcher and cleans failed launches", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "image-open-test-"))
    let launches = 0
    try {
      await expect(
        openFullResolutionImage("https://example.com/a.png", signal(), {
          fetch: response(),
          cacheRoot: directory,
          launch: async (filename) => {
            launches++
            expect(filename.startsWith(directory)).toBe(true)
            expect(await readFile(filename)).toEqual(Buffer.from(png))
            throw new Error("viewer failed")
          },
        }),
      ).rejects.toThrow("viewer failed")
      expect(launches).toBe(1)
      expect(await readdir(directory)).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("rejects unsafe schemes, UNC, non-images and size limits before launch", async () => {
    expect(() => localImagePath("file://remote/share/image.png")).toThrow()
    expect(() => localImagePath("\\\\server\\share\\image.png")).toThrow()
    expect(() => localImagePath("C:\\image.png\x00cmd")).toThrow()
    for (const source of ["javascript:alert(1)", "ftp://example.com/a.png", "https://user:pass@example.com/a.png"]) {
      await expect(readImageSource(source, signal())).rejects.toThrow()
    }
    await expect(
      prepareImageForOpen("https://example.com/a.png", signal(), {
        fetch: response(new TextEncoder().encode("not an image")),
      }),
    ).rejects.toThrow("unsupported image")
    await expect(
      readImageSource("https://example.com/a.png", signal(), { fetch: response(), maxBytes: 2 }),
    ).rejects.toThrow("too large")
    const aborted = new AbortController()
    aborted.abort()
    await expect(readImageSource("https://example.com/a.png", aborted.signal, { fetch: response() })).rejects.toThrow()
  })

  test("cancels a chunked response once it exceeds the cap", async () => {
    let cancelled = false
    const fetcher = Object.assign(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(16))
            },
            cancel() {
              cancelled = true
            },
          }),
          { headers: { "content-type": "image/png" } },
        ),
      { preconnect: fetch.preconnect },
    ) satisfies typeof fetch
    await expect(
      readImageSource("https://example.com/a.png", signal(), { fetch: fetcher, maxBytes: 8 }),
    ).rejects.toThrow("too large")
    expect(cancelled).toBe(true)
  })
})
