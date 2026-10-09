import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { guardNikFetch } from "../helpers/no-nik-fetch"

/*
 * Brief ragu-via-servizi-nik, package B, review M3: `ragu web` opened the server's `/`, which the proxy to
 * app.nikcli-ai.dev used to answer. Without the proxy `/` is a 404, so the command opens the local web interface the
 * server does serve, `/companion`.
 */
describe("ragu web opens a page the server serves", () => {
  test("the address it opens is /companion, on the server it started", async () => {
    const { webInterfaceUrl } = await import("@/cli/handlers/web")
    expect(webInterfaceUrl("http://127.0.0.1:4096/")).toBe("http://127.0.0.1:4096/companion")
    expect(webInterfaceUrl("http://localhost:51234")).toBe("http://localhost:51234/companion")
  })

  test("that page answers 200 with HTML, and / stays a 404, without calling Nik", async () => {
    const guard = guardNikFetch()
    try {
      const { Server } = await import("@/server/server")
      const page = await Server.fetch(new Request("http://localhost/companion"))
      expect(page.status).toBe(200)
      expect(page.headers.get("content-type")).toContain("text/html")
      const root = await Server.fetch(new Request("http://localhost/"))
      expect(root.status).toBe(404)
      expect(guard.attempts).toEqual([])
    } finally {
      guard.restore()
    }
  })

  test("both addresses the command opens go through webInterfaceUrl", () => {
    const source = fs.readFileSync(path.join(import.meta.dir, "../../src/cli/handlers/web.ts"), "utf8")
    expect(source).toContain("const localhostUrl = webInterfaceUrl(")
    expect(source).toContain("const displayUrl = webInterfaceUrl(")
    expect(source.match(/open\((\w+)\)/g)).toEqual(["open(localhostUrl)", "open(displayUrl)"])
  })
})
