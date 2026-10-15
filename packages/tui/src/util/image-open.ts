import { spawn } from "node:child_process"
import { mkdtemp, open, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const MAX_IMAGE_SOURCE_BYTES = 10 * 1024 * 1024
const CACHE_LIFETIME_MS = 10 * 60 * 1000
const cachedFiles = new Set<() => Promise<void>>()

export function localImagePath(source: string): string | undefined {
  if (/[\x00-\x1f\x7f]/.test(source)) throw new Error("invalid image source")
  if (source.startsWith("file:")) {
    const url = new URL(source)
    if (url.search || url.hash) throw new Error("file URLs must not have query parameters or fragments")
    if (url.hostname && url.hostname !== "localhost") throw new Error("remote file URLs are not supported")
    const filename = fileURLToPath(url)
    if (filename.startsWith("\\\\")) throw new Error("network paths are not supported")
    return filename
  }
  if (/^[A-Za-z]:[\\/]/.test(source) || source.startsWith("/")) return source
  if (source.startsWith("\\\\")) throw new Error("network paths are not supported")
  return undefined
}

export function imageFileExtension(bytes: Uint8Array): string {
  const at = (offset: number, text: string) =>
    [...text].every((ch, index) => bytes[offset + index] === ch.charCodeAt(0))
  if (bytes.length >= 24 && bytes[0] === 0x89 && at(1, "PNG\r\n\x1a\n")) return "png"
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg"
  if (bytes.length >= 10 && (at(0, "GIF87a") || at(0, "GIF89a"))) return "gif"
  if (bytes.length >= 12 && at(0, "RIFF") && at(8, "WEBP")) return "webp"
  if (bytes.length >= 26 && at(0, "BM")) return "bmp"
  if (bytes.length >= 8 && (at(0, "II\x2a\x00") || at(0, "MM\x00\x2a"))) return "tiff"
  throw new Error("unsupported image content")
}

async function localBytes(filename: string, signal: AbortSignal, maxBytes: number) {
  signal.throwIfAborted()
  const handle = await open(filename, "r")
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error("image source is not a regular file")
    if (info.size > maxBytes) throw new Error("image is too large")
    const bytes = new Uint8Array(Math.min(info.size + 1, maxBytes + 1))
    let length = 0
    while (length < bytes.length) {
      signal.throwIfAborted()
      const chunk = await handle.read(bytes, length, bytes.length - length, null)
      if (!chunk.bytesRead) break
      length += chunk.bytesRead
    }
    if (length > maxBytes || length > info.size) throw new Error("image grew while reading")
    return bytes.subarray(0, length)
  } finally {
    await handle.close()
  }
}

export async function readImageSource(
  source: string,
  signal: AbortSignal,
  options: { fetch?: typeof fetch; maxBytes?: number } = {},
) {
  const maxBytes = options.maxBytes ?? MAX_IMAGE_SOURCE_BYTES
  const filename = localImagePath(source)
  if (filename) return localBytes(filename, signal, maxBytes)
  signal.throwIfAborted()
  if (source.startsWith("data:image/")) {
    const match = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]*)$/i.exec(source)
    if (!match) throw new Error("invalid image data URL")
    if (match[1]!.length > Math.ceil(maxBytes / 3) * 4) throw new Error("image is too large")
    const bytes = Uint8Array.fromBase64(match[1]!)
    if (bytes.byteLength > maxBytes) throw new Error("image is too large")
    return bytes
  }
  const url = new URL(source)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("unsupported image URL")
  }
  const response = await (options.fetch ?? fetch)(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    headers: { Accept: "image/*" },
  })
  const cancel = () => response.body?.cancel().catch(() => {})
  if (!response.ok) {
    await cancel()
    throw new Error(`HTTP ${response.status}`)
  }
  const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
  if (type && !type.startsWith("image/")) {
    await cancel()
    throw new Error("URL is not an image")
  }
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await cancel()
    throw new Error("image is too large")
  }
  if (!response.body) throw new Error("image response has no body")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maxBytes) throw new Error("image is too large")
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

export async function prepareImageForOpen(
  source: string,
  signal: AbortSignal,
  options: { fetch?: typeof fetch; maxBytes?: number; cacheRoot?: string } = {},
): Promise<{ filename: string; dispose: () => Promise<void> }> {
  const local = localImagePath(source)
  const filename = local ? await realpath(local) : undefined
  if (filename && !(await stat(filename)).isFile()) throw new Error("image source is not a regular file")
  const bytes = await readImageSource(filename ?? source, signal, options)
  signal.throwIfAborted()
  const extension = imageFileExtension(bytes)
  if (filename) {
    const actual = path
      .extname(filename)
      .slice(1)
      .toLowerCase()
      .replace(/^jpeg$/, "jpg")
      .replace(/^tif$/, "tiff")
    if (actual !== extension) throw new Error("image extension does not match its content")
    return { filename, dispose: async () => {} }
  }
  const directory = await mkdtemp(path.join(options.cacheRoot ?? tmpdir(), "ragu-image-"))
  const cached = path.join(directory, `image.${extension}`)
  try {
    await writeFile(cached, bytes, { mode: 0o600, flag: "wx" })
    signal.throwIfAborted()
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const dispose = async () => {
    clearTimeout(timer)
    cachedFiles.delete(dispose)
    await rm(directory, { recursive: true, force: true })
  }
  if (cachedFiles.size >= 16) await cachedFiles.values().next().value?.()
  cachedFiles.add(dispose)
  timer = setTimeout(() => void dispose().catch(() => {}), CACHE_LIFETIME_MS)
  timer.unref()
  return { filename: cached, dispose }
}

export async function launchImageViewer(filename: string) {
  if (process.platform === "win32") {
    const { dlopen, FFIType, ptr } = await import("bun:ffi")
    const library = dlopen("shell32.dll", {
      ShellExecuteW: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32],
        returns: FFIType.u64,
      },
    })
    const verb = Buffer.from("open\0", "utf16le")
    const target = Buffer.from(`${filename}\0`, "utf16le")
    try {
      const result = library.symbols.ShellExecuteW(null, ptr(verb), ptr(target), null, null, 1)
      if (BigInt(result) <= 32n) throw new Error(`image viewer refused the file (${result})`)
    } finally {
      library.close()
    }
    return
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.platform === "darwin" ? "/usr/bin/open" : "xdg-open", [filename], {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    })
    child.once("error", reject)
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`image viewer exited ${code}`))))
  })
}

export async function openFullResolutionImage(
  source: string,
  signal: AbortSignal,
  options: Parameters<typeof prepareImageForOpen>[2] & { launch?: typeof launchImageViewer } = {},
) {
  const prepared = await prepareImageForOpen(source, signal, options)
  try {
    signal.throwIfAborted()
    await (options.launch ?? launchImageViewer)(prepared.filename)
  } catch (error) {
    await prepared.dispose()
    throw error
  }
}
