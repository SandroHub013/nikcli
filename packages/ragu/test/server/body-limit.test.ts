import { afterAll, describe, expect, it } from "bun:test"
import { limitFor, bodyLimitResponse } from "@/server/middleware/body-limit"

const ORIGINAL = process.env["RAGU_DEFAULT_BODY_MAX"]

function postWithBody(url: string, body: string, env: { [k: string]: number } = {}) {
  // Bun's `new Request(url, { body: string })` does NOT auto-set Content-Length;
  // we set it explicitly so the middleware's CL-based pre-check fires.
  const headers = new Headers({
    "Content-Type": "text/plain",
    "Content-Length": String(body.length),
  })
  if (env["RAGU_DEFAULT_BODY_MAX"] !== undefined) {
    process.env["RAGU_DEFAULT_BODY_MAX"] = String(env["RAGU_DEFAULT_BODY_MAX"])
  } else {
    delete process.env["RAGU_DEFAULT_BODY_MAX"]
  }
  return new Request(url, { method: "POST", body, headers })
}

describe("body-limit middleware", () => {
  afterAll(() => {
    if (ORIGINAL === undefined) delete process.env["RAGU_DEFAULT_BODY_MAX"]
    else process.env["RAGU_DEFAULT_BODY_MAX"] = ORIGINAL
  })

  describe("limitFor", () => {
    it("returns default (256 MB) when no env override is set", () => {
      delete process.env["RAGU_DEFAULT_BODY_MAX"]
      expect(limitFor()).toBe(256 * 1024 * 1024)
    })

    it("honours RAGU_DEFAULT_BODY_MAX override at call time", () => {
      process.env["RAGU_DEFAULT_BODY_MAX"] = "131072" // 128 KB
      expect(limitFor()).toBe(131072)
    })
  })

  describe("bodyLimitResponse (HTTP)", () => {
    const handle = (request: Request) => bodyLimitResponse(request) ?? new Response("ok")

    it("accepts a small body under the default", async () => {
      const res = handle(postWithBody("http://localhost/echo", "hello"))
      expect(res.status).toBe(200)
    })

    it("rejects a body over the default with 413", async () => {
      const res = handle(postWithBody("http://localhost/echo", "x".repeat(2048), { RAGU_DEFAULT_BODY_MAX: 1024 }))
      expect(res.status).toBe(413)
    })

    it("gives the old teleport upload path no larger budget", async () => {
      // Teleport, which uploaded whole workspaces there, is gone: the path is
      // held to the same limit as every other.
      const res = handle(
        postWithBody("http://localhost/mobile/teleport/upload", "x".repeat(100 * 1024), {
          RAGU_DEFAULT_BODY_MAX: 1024,
        }),
      )
      expect(res.status).toBe(413)
    })

    it("skips the check when Content-Length is missing (chunked transfer)", async () => {
      // No Content-Length → middleware passes through; Bun's server-wide
      // maxRequestBodySize (configured separately) is the last line of defence.
      delete process.env["RAGU_DEFAULT_BODY_MAX"]
      const req = new Request("http://localhost/echo", { method: "POST", body: "anything" })
      const res = handle(req)
      expect(res.status).toBe(200)
    })
  })
})
