import { Flag } from "@ragu/util/flag"

/**
 * Body-size middleware.
 *
 * Bun's `maxRequestBodySize` (`RAGU_SERVER_MAX_BODY`, default 2 GB) is a
 * server-wide ceiling. That ceiling is too
 * generous for everyday API endpoints: a probe could otherwise declare a huge
 * `Content-Length` and force the server to allocate/buffer up to the ceiling.
 *
 * This middleware rejects requests whose `Content-Length` exceeds the limit:
 * `RAGU_DEFAULT_BODY_MAX`, else 256 MB, never above the ceiling.
 *
 * Behaviour:
 * - If `Content-Length` is missing, we accept (chunked uploads without CL fall
 *   through and remain bounded by Bun's server-wide ceiling).
 * - On rejection we return `413 Payload Too Large` with a plain-text body.
 * - Mounted before auth so oversized probes do not pay JWT/auth cost.
 */
const DEFAULT_LIMIT_BYTES = 256 * 1024 * 1024 // 256 MB
const LARGE_BODY_LIMIT_BYTES = 2 * 1024 * 1024 * 1024 // 2 GB (matches Bun default ceiling)

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

/** Server-wide ceiling, aligned with Bun.serve. */
export function largeBodyLimit(): number {
  return Flag.RAGU_SERVER_MAX_BODY ?? LARGE_BODY_LIMIT_BYTES
}

export function limitFor(): number {
  const ceiling = largeBodyLimit()
  const configured = parsePositiveInt(process.env["RAGU_DEFAULT_BODY_MAX"]) ?? DEFAULT_LIMIT_BYTES
  return Math.min(configured, ceiling)
}

export function bodyLimitResponse(request: Request): Response | undefined {
  const header = request.headers.get("content-length")
  if (header) {
    const n = Number(header)
    const limit = limitFor()
    if (Number.isFinite(n) && n > limit) {
      return new Response(`Payload too large (limit ${limit} bytes)`, {
        status: 413,
        headers: { "Content-Type": "text/plain" },
      })
    }
  }
}
