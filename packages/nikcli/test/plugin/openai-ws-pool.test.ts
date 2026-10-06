import { afterAll, describe, expect, test } from "bun:test"
import { OpenAIWebSocketPool } from "../../src/plugin/openai/ws-pool"
import { LLM } from "../../src/session/llm"

/*
 * Headless `nikcli run` on a ChatGPT plan has to reach the WebSocket pool with a session to key it on.
 * The Codex request carries `session_id` (LLM.buildRequestHeaders); the pool used to look only for
 * `x-session-affinity` / `session-id`, so every headless request fell back to HTTP ("missing_session").
 * Titles stay on HTTP, and a failed WebSocket still falls back to HTTP.
 */

const received: Array<{ headers: Record<string, string>; message: unknown }> = []
const server = Bun.serve<{ headers: Record<string, string> }>({
  port: 0,
  fetch(req, srv) {
    const headers: Record<string, string> = {}
    req.headers.forEach((v, k) => (headers[k] = v))
    if (srv.upgrade(req, { data: { headers } })) return undefined
    return new Response("not a websocket", { status: 426 })
  },
  websocket: {
    message(ws, raw) {
      received.push({ headers: ws.data.headers, message: JSON.parse(String(raw)) })
      const resp = { id: "resp_1", model: "gpt-6-luna", status: "completed", usage: { input_tokens: 5, output_tokens: 1 } }
      ws.send(JSON.stringify({ type: "response.created", response: { ...resp, status: "in_progress" } }))
      ws.send(JSON.stringify({ type: "response.completed", response: resp }))
    },
  },
})
afterAll(() => server.stop(true))

const url = () => `http://127.0.0.1:${server.port}/backend-api/codex/responses`
const body = JSON.stringify({ model: "gpt-6-luna", stream: true, input: [{ role: "user", content: "hi" }] })

function pool() {
  const http: Array<{ url: string; headers: Headers }> = []
  const httpFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    http.push({ url: String(input), headers: new Headers(init?.headers) })
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  }) as typeof fetch
  return { http, fetch: OpenAIWebSocketPool.createWebSocketFetch({ httpFetch }) }
}

const post = (headers: Record<string, string>) => ({ method: "POST", headers, body })

describe("codex requests and the WebSocket pool", () => {
  test("a request with the Codex session_id header goes over the WebSocket", async () => {
    received.length = 0
    const p = pool()
    const res = await p.fetch(url(), post({ session_id: "ses_headless", originator: "nikcli" }))
    const text = await res.text()
    p.fetch.close()
    expect(p.http).toHaveLength(0)
    expect(received).toHaveLength(1)
    expect((received[0].message as { type: string }).type).toBe("response.create")
    expect(received[0].headers.session_id).toBe("ses_headless")
    expect(text).toContain("response.completed")
  })

  test("two sessions (a session and its subagent) each get their own socket", async () => {
    received.length = 0
    const p = pool()
    await (await p.fetch(url(), post({ session_id: "ses_parent" }))).text()
    await (await p.fetch(url(), post({ session_id: "ses_child" }))).text()
    await (await p.fetch(url(), post({ session_id: "ses_parent" }))).text()
    p.fetch.close()
    expect(p.http).toHaveLength(0)
    expect(received.map((r) => r.headers.session_id)).toEqual(["ses_parent", "ses_child", "ses_parent"])
  })

  test("no session header: HTTP, as before", async () => {
    received.length = 0
    const p = pool()
    await (await p.fetch(url(), post({ originator: "nikcli" }))).text()
    p.fetch.close()
    expect(p.http).toHaveLength(1)
    expect(received).toHaveLength(0)
  })

  test("a title request stays on HTTP and the internal marker is not sent upstream", async () => {
    received.length = 0
    const p = pool()
    await (await p.fetch(url(), post({ session_id: "ses_headless", [OpenAIWebSocketPool.TITLE_HEADER]: "true" }))).text()
    p.fetch.close()
    expect(received).toHaveLength(0)
    expect(p.http).toHaveLength(1)
    expect(p.http[0].headers.get(OpenAIWebSocketPool.TITLE_HEADER)).toBeNull()
    expect(p.http[0].headers.get("session_id")).toBe("ses_headless")
  })

  test("a WebSocket that cannot connect falls back to HTTP", async () => {
    received.length = 0
    const p = pool()
    const res = await p.fetch("http://127.0.0.1:1/backend-api/codex/responses", post({ session_id: "ses_down" }))
    await res.text()
    p.fetch.close()
    expect(p.http).toHaveLength(1)
  })
})

describe("LLM.buildRequestHeaders for the Codex provider", () => {
  test("carries the session id, and marks titles for the pool", () => {
    const plain = LLM.buildRequestHeaders("proj", "openai", "ses_1", "usr_1", true, undefined, false)!
    expect(plain.session_id).toBe("ses_1")
    expect(plain[OpenAIWebSocketPool.TITLE_HEADER]).toBeUndefined()
    const title = LLM.buildRequestHeaders("proj", "openai", "ses_1", "usr_1", true, undefined, true)!
    expect(title[OpenAIWebSocketPool.TITLE_HEADER]).toBe("true")
    expect(title.session_id).toBe("ses_1")
  })

  test("other providers never get the marker", () => {
    const other = LLM.buildRequestHeaders("proj", "openrouter", "ses_1", "usr_1", false, undefined, true)
    expect(JSON.stringify(other ?? {})).not.toContain(OpenAIWebSocketPool.TITLE_HEADER)
  })
})
