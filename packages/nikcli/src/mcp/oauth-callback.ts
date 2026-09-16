import { Log } from "@nikcli-ai/util/log"
import { OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_PATH } from "./oauth-provider"

const log = Log.create({ service: "mcp.oauth-callback" })

const HTML_SUCCESS = `<!DOCTYPE html>
<html>
<head>
  <title>Nikcli - Authorization Successful</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #4ade80; margin-bottom: 1rem; }
    p { color: #aaa; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Successful</h1>
    <p>You can close this window and return to Nikcli.</p>
  </div>
  <script>setTimeout(() => window.close(), 2000);</script>
</body>
</html>`

const HTML_ERROR = (error: string) => `<!DOCTYPE html>
<html>
<head>
  <title>Nikcli - Authorization Failed</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #f87171; margin-bottom: 1rem; }
    p { color: #aaa; }
    .error { color: #fca5a5; font-family: monospace; margin-top: 1rem; padding: 1rem; background: rgba(248,113,113,0.1); border-radius: 0.5rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Failed</h1>
    <p>An error occurred during authorization.</p>
    <div class="error">${error}</div>
  </div>
</body>
</html>`

interface PendingAuth {
  resolve: (code: string) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

export namespace McpOAuthCallback {
  let server: ReturnType<typeof Bun.serve> | undefined
  const pendingAuths = new Map<string, PendingAuth>()

  const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000

  /**
   * Path a second process probes to learn who owns {@link OAUTH_CALLBACK_PORT}.
   * Answering it is what separates "another nikcli holds the port" from "an
   * unrelated service holds it" — a distinction the old bare TCP connect could
   * not make, and the reason the wrong answer was silent.
   */
  const OWNER_PROBE_PATH = "/mcp/oauth/owner"
  const OWNER_MARKER = "nikcli-mcp-oauth-callback"

  export async function ensureRunning(): Promise<void> {
    if (server) return

    // The callback listens on one fixed port, so at most one process in this
    // machine can receive it. When somebody else holds the port, this process
    // used to carry on and register the pending state in its *own* map: the
    // browser then delivered the code to the other listener, which answered
    // "Invalid or expired state" (or 404, for a foreign service), and the
    // authorization here simply hung for five minutes and timed out with no
    // explanation. Saying so up front is the whole fix — there is nothing this
    // process can do to receive that redirect.
    const owner = await probeOwner()
    if (owner === "nikcli") {
      throw new Error(
        `Another nikcli instance already owns the MCP OAuth callback port (${OAUTH_CALLBACK_PORT}). ` +
          `Finish or cancel the authorization running there, then try again.`,
      )
    }
    if (owner === "foreign") {
      throw new Error(
        `Port ${OAUTH_CALLBACK_PORT} is in use by another program, so the MCP OAuth callback cannot be received. ` +
          `Stop that program and try again.`,
      )
    }

    server = Bun.serve({
      port: OAUTH_CALLBACK_PORT,
      fetch(req) {
        const url = new URL(req.url)

        if (url.pathname === OWNER_PROBE_PATH) return new Response(OWNER_MARKER)

        if (url.pathname !== OAUTH_CALLBACK_PATH) {
          return new Response("Not found", { status: 404 })
        }

        const code = url.searchParams.get("code")
        const state = url.searchParams.get("state")
        const error = url.searchParams.get("error")
        const errorDescription = url.searchParams.get("error_description")

        log.info("received oauth callback", { hasCode: !!code, state, error })

        if (!state) {
          const errorMsg = "Missing required state parameter - potential CSRF attack"
          log.error("oauth callback missing state parameter", { url: url.toString() })
          return new Response(HTML_ERROR(errorMsg), {
            status: 400,
            headers: { "Content-Type": "text/html" },
          })
        }

        if (error) {
          const errorMsg = errorDescription || error
          if (pendingAuths.has(state)) {
            const pending = pendingAuths.get(state)!
            clearTimeout(pending.timeout)
            pendingAuths.delete(state)
            pending.reject(new Error(errorMsg))
          }
          return new Response(HTML_ERROR(errorMsg), {
            headers: { "Content-Type": "text/html" },
          })
        }

        if (!code) {
          return new Response(HTML_ERROR("No authorization code provided"), {
            status: 400,
            headers: { "Content-Type": "text/html" },
          })
        }

        if (!pendingAuths.has(state)) {
          const errorMsg = "Invalid or expired state parameter - potential CSRF attack"
          log.error("oauth callback with invalid state", { state, pendingStates: Array.from(pendingAuths.keys()) })
          return new Response(HTML_ERROR(errorMsg), {
            status: 400,
            headers: { "Content-Type": "text/html" },
          })
        }

        const pending = pendingAuths.get(state)!

        clearTimeout(pending.timeout)
        pendingAuths.delete(state)
        pending.resolve(code)

        return new Response(HTML_SUCCESS, {
          headers: { "Content-Type": "text/html" },
        })
      },
    })

    log.info("oauth callback server started", { port: OAUTH_CALLBACK_PORT })
  }

  export function waitForCallback(oauthState: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (pendingAuths.has(oauthState)) {
          pendingAuths.delete(oauthState)
          reject(new Error("OAuth callback timeout - authorization took too long"))
        }
      }, CALLBACK_TIMEOUT_MS)

      pendingAuths.set(oauthState, { resolve, reject, timeout })
    })
  }

  export function cancelPending(mcpName: string): void {
    const pending = pendingAuths.get(mcpName)
    if (pending) {
      clearTimeout(pending.timeout)
      pendingAuths.delete(mcpName)
      pending.reject(new Error("Authorization cancelled"))
    }
  }

  /**
   * Who is listening on the callback port: another nikcli, an unrelated
   * program, or nobody.
   */
  async function probeOwner(): Promise<"nikcli" | "foreign" | "free"> {
    if (!(await isPortInUse())) return "free"
    try {
      const response = await fetch(`http://127.0.0.1:${OAUTH_CALLBACK_PORT}${OWNER_PROBE_PATH}`, {
        signal: AbortSignal.timeout(2_000),
      })
      return (await response.text()).trim() === OWNER_MARKER ? "nikcli" : "foreign"
    } catch {
      // Something accepted the connection but did not speak HTTP back, which
      // makes it foreign by definition — it will not hand us the redirect.
      return "foreign"
    }
  }

  export async function isPortInUse(): Promise<boolean> {
    return new Promise((resolve) => {
      Bun.connect({
        hostname: "127.0.0.1",
        port: OAUTH_CALLBACK_PORT,
        socket: {
          open(socket) {
            socket.end()
            resolve(true)
          },
          error() {
            resolve(false)
          },
          data() {},
          close() {},
        },
      }).catch(() => {
        resolve(false)
      })
    })
  }

  export async function stop(): Promise<void> {
    if (server) {
      server.stop()
      server = undefined
      log.info("oauth callback server stopped")
    }

    for (const [, pending] of pendingAuths) {
      clearTimeout(pending.timeout)
      pending.reject(new Error("OAuth callback server stopped"))
    }
    pendingAuths.clear()
  }

  export function isRunning(): boolean {
    return server !== undefined
  }
}
