import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { createNikcliClient } from "@nikcli-ai/sdk/client"
import { SERVER_BASE, serverFetch, type ProxyEvent, type ProxyRequest, type ServerBridge } from "./transport"

/*
 * C1: the chat reaches nikcli through ADE's Rust side. A `fetch` from the
 * WebView fails in a release (origin `tauri.localhost`, which the server's
 * CORS does not accept) and would need the server's password. The bridge here
 * is a fake of the three Rust commands; the SDK on top of it is the real one.
 */

const bytes = (text: string) => Array.from(new TextEncoder().encode(text))

interface Sent {
  readonly request: ProxyRequest
  readonly emit: (event: ProxyEvent) => void
  readonly id: number
}

function fakeBridge(options: { startFails?: number } = {}) {
  const sent: Sent[] = []
  const aborted: number[] = []
  let starts = 0
  let failures = options.startFails ?? 0
  const answers: ((sent: Sent) => void)[] = []
  const bridge: ServerBridge = {
    async start() {
      starts++
      if (failures > 0) {
        failures--
        throw new Error("nikcli non è nel PATH")
      }
      return { url: "http://127.0.0.1:49374", version: "1.384.0" }
    },
    async send(request, onEvent) {
      const entry = { request, emit: onEvent, id: sent.length + 1 }
      sent.push(entry)
      answers.shift()?.(entry)
      return entry.id
    },
    async abort(id) {
      aborted.push(id)
    },
  }
  return {
    bridge,
    sent,
    aborted,
    starts: () => starts,
    /** How the next request is answered. */
    answer: (respond: (sent: Sent) => void) => void answers.push(respond),
  }
}

const json = (status: number, body: unknown) => (sent: Sent) => {
  sent.emit({ kind: "head", status, headers: [["content-type", "application/json"]] })
  sent.emit({ kind: "chunk", bytes: bytes(JSON.stringify(body)) })
  sent.emit({ kind: "end" })
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

let fetchSpy: ReturnType<typeof spyOn> | undefined
afterEach(() => fetchSpy?.mockRestore())

describe("il trasporto della chat", () => {
  test("l'SDK vero chiama health e provider.list, e la fetch del WebView non parte mai", async () => {
    fetchSpy = spyOn(globalThis, "fetch")
    const fake = fakeBridge()
    fake.answer(json(200, { healthy: true, version: "1.384.0" }))
    fake.answer(json(200, { all: [], default: {}, connected: [] }))
    const client = createNikcliClient({
      baseUrl: SERVER_BASE,
      fetch: serverFetch(fake.bridge),
      directory: "C:/progetto",
    })

    const health = await client.global.health()
    expect(health.data).toEqual({ healthy: true, version: "1.384.0" })
    const providers = await client.provider.list()
    expect(providers.data).toEqual({ all: [], default: {}, connected: [] })

    expect(fake.sent.map((s) => [s.request.method, s.request.path])).toEqual([
      ["GET", "/global/health"],
      ["GET", "/provider"],
    ])
    expect(fake.sent[1]!.request.headers).toContainEqual(["x-nikcli-directory", "C:/progetto"])
    expect(fake.starts()).toBe(1)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test("un corpo JSON arriva al server così com'è", async () => {
    const fake = fakeBridge()
    fake.answer(json(200, { id: "s1" }))
    const fetch = serverFetch(fake.bridge)
    const response = await fetch(`${SERVER_BASE}/session?x=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "prova" }),
    })
    expect(await response.json()).toEqual({ id: "s1" })
    expect(fake.sent[0]!.request).toMatchObject({ method: "POST", path: "/session?x=1", body: '{"title":"prova"}' })
  })

  test("la pagina non manda credenziali: le aggiunge Rust", async () => {
    const fake = fakeBridge()
    fake.answer(json(200, {}))
    await serverFetch(fake.bridge)(`${SERVER_BASE}/provider`, { headers: { authorization: "Basic ZmFsc28=" } })
    expect(fake.sent[0]!.request.headers.some(([name]) => name === "authorization")).toBe(false)
  })

  test("uno stream di eventi arriva a pezzi, mentre è scritto", async () => {
    const fake = fakeBridge()
    let emit: ((event: ProxyEvent) => void) | undefined
    fake.answer((sent) => {
      emit = sent.emit
      sent.emit({ kind: "head", status: 200, headers: [["content-type", "text/event-stream"]] })
    })
    const response = await serverFetch(fake.bridge)(`${SERVER_BASE}/global/event`)
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()

    emit!({ kind: "chunk", bytes: bytes("data: uno\n\n") })
    expect(decoder.decode((await reader.read()).value)).toBe("data: uno\n\n")
    emit!({ kind: "chunk", bytes: bytes("data: due\n\n") })
    expect(decoder.decode((await reader.read()).value)).toBe("data: due\n\n")
    emit!({ kind: "end" })
    expect((await reader.read()).done).toBe(true)
  })

  test("interrompere la richiesta la ferma anche in Rust", async () => {
    const fake = fakeBridge()
    fake.answer((sent) => sent.emit({ kind: "head", status: 200, headers: [] }))
    const controller = new AbortController()
    const response = await serverFetch(fake.bridge)(`${SERVER_BASE}/global/event`, { signal: controller.signal })
    const reading = response.body!.getReader().read()
    controller.abort()
    await expect(reading).rejects.toThrow()
    await tick()
    expect(fake.aborted).toEqual([1])
  })

  test("smettere di leggere lo stream lo ferma in Rust", async () => {
    const fake = fakeBridge()
    fake.answer((sent) => sent.emit({ kind: "head", status: 200, headers: [] }))
    const response = await serverFetch(fake.bridge)(`${SERVER_BASE}/global/event`)
    await response.body!.cancel()
    await tick()
    expect(fake.aborted).toEqual([1])
  })

  test("un indirizzo diverso dal server è rifiutato prima di partire", async () => {
    const fake = fakeBridge()
    await expect(serverFetch(fake.bridge)("https://evil.example/x")).rejects.toThrow("solo con il server di nikcli")
    expect(fake.starts()).toBe(0)
    expect(fake.sent).toHaveLength(0)
  })

  test("un errore prima della risposta rifiuta la fetch, e al giro dopo il server si cerca di nuovo", async () => {
    const fake = fakeBridge()
    fake.answer((sent) => sent.emit({ kind: "error", message: "il server di nikcli non risponde" }))
    fake.answer(json(200, { healthy: true, version: "1" }))
    const fetch = serverFetch(fake.bridge)
    await expect(fetch(`${SERVER_BASE}/global/health`)).rejects.toThrow("il server di nikcli non risponde")
    expect((await fetch(`${SERVER_BASE}/global/health`)).status).toBe(200)
    expect(fake.starts()).toBe(2)
  })

  test("un avvio fallito non resta in memoria: la chiamata dopo riprova", async () => {
    const fake = fakeBridge({ startFails: 1 })
    fake.answer(json(200, {}))
    const fetch = serverFetch(fake.bridge)
    await expect(fetch(`${SERVER_BASE}/provider`)).rejects.toThrow("nikcli non è nel PATH")
    expect((await fetch(`${SERVER_BASE}/provider`)).status).toBe(200)
    expect(fake.starts()).toBe(2)
  })

  test("una risposta senza corpo (204) non rompe il Response", async () => {
    const fake = fakeBridge()
    fake.answer((sent) => {
      sent.emit({ kind: "head", status: 204, headers: [] })
      sent.emit({ kind: "end" })
    })
    const response = await serverFetch(fake.bridge)(`${SERVER_BASE}/session/s1`, { method: "DELETE" })
    expect(response.status).toBe(204)
  })
})
