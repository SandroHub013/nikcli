import { describe, expect, test } from "bun:test"
import { createRoot, createEffect } from "solid-js"
import { openChat } from "./connection"
import { createChatStore, type ChatStoreDeps } from "./store"
import type { ProxyEvent, ProxyRequest, ServerBridge } from "./transport"

/*
 * C2: the chat's store, on a fake server behind the real connection and
 * stream. What the plan asks of it: the answer keeps coming when the Chat
 * section is left; and from the review: close stops the stream once, another
 * folder does not stop the answer in this one, a refusal is final.
 */

const A = "C:/progetto-a"
const B = "C:/progetto-b"
const FREE = { providerID: "openrouter", modelID: "nvidia/nemotron-3-super-120b-a12b:free" }
const bytes = (text: string) => Array.from(new TextEncoder().encode(text))
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: string, check: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error(`tempo scaduto: ${what}`)
    await tick(2)
  }
}

const session = (id: string) => ({ id, title: id, directory: A, time: { created: 1, updated: 1 } })
const assistant = (id: string, sessionID = "ses_1") => ({ id, sessionID, role: "assistant", time: { created: 2 } })
const textPart = (id: string, messageID: string, text: string) => ({ id, messageID, sessionID: "ses_1", type: "text", text })

/** A fake nikcli server: `/event` streams what the test pushes, the rest answers from `routes`. */
function fakeServer() {
  const sent: ProxyRequest[] = []
  const aborted: number[] = []
  const streams: { id: number; directory: string; push: (event: object) => void; end: () => void }[] = []
  const routes = {
    sessions: [session("ses_1")] as object[],
    messages: {} as Record<string, object[]>,
    permissions: [] as object[],
    questions: [] as object[],
    status: {} as Record<string, object>,
    /** Holds the answer to GET /session/status until it settles. */
    statusGate: undefined as Promise<void> | undefined,
  }
  const reply = (onEvent: (event: ProxyEvent) => void, status: number, body?: unknown) =>
    setTimeout(() => {
      onEvent({ kind: "head", status, headers: [["content-type", "application/json"]] })
      if (body !== undefined) onEvent({ kind: "chunk", bytes: bytes(JSON.stringify(body)) })
      onEvent({ kind: "end" })
    }, 1)
  const bridge: ServerBridge = {
    async start() {
      return { url: "http://127.0.0.1:49374", version: "1.389.0", shared: true }
    },
    async send(request, onEvent) {
      sent.push(request)
      const id = sent.length
      const path = request.path.split("?")[0]!
      const header = request.headers.find(([name]) => name.toLowerCase() === "x-nikcli-directory")?.[1] ?? ""
      if (path === "/event") {
        let open = true
        // As the real bridge does: nothing of the body before the head.
        const head = new Promise<void>((resolve) =>
          setTimeout(() => {
            onEvent({ kind: "head", status: 200, headers: [["content-type", "text/event-stream"]] })
            resolve()
          }, 1),
        )
        streams.push({
          id,
          directory: decodeURIComponent(header),
          push: (event) => void head.then(() => open && onEvent({ kind: "chunk", bytes: bytes(`data: ${JSON.stringify(event)}\n\n`) })),
          end: () =>
            void head.then(() => {
              if (open) onEvent({ kind: "end" })
              open = false
            }),
        })
        return id
      }
      if (request.method === "GET" && path === "/session") reply(onEvent, 200, routes.sessions)
      else if (request.method === "GET" && path === "/session/status") {
        const status = routes.status
        void (routes.statusGate ?? Promise.resolve()).then(() => reply(onEvent, 200, status))
      }
      else if (request.method === "GET" && path === "/permission") reply(onEvent, 200, routes.permissions)
      else if (request.method === "GET" && path === "/question") reply(onEvent, 200, routes.questions)
      else if (request.method === "GET" && /^\/session\/[^/]+\/message$/.test(path)) {
        reply(onEvent, 200, routes.messages[path.split("/")[2]!] ?? [])
      } else if (request.method === "POST" && path === "/session") reply(onEvent, 200, session("ses_nuova"))
      else if (request.method === "POST" && path.endsWith("/prompt_async")) reply(onEvent, 204)
      else if (request.method === "POST" && path.endsWith("/abort")) reply(onEvent, 200, true)
      else reply(onEvent, 404, { error: "non previsto" })
      return id
    },
    async abort(id) {
      aborted.push(id)
    },
  }
  const stream = () => streams.at(-1)!
  const calls = (method: string, path: RegExp) => sent.filter((r) => r.method === method && path.test(r.path.split("?")[0]!))
  return { bridge, sent, aborted, streams, stream, routes, calls }
}

function storeOn(
  server: ReturnType<typeof fakeServer>,
  extra: Partial<ChatStoreDeps> & { trusted?: () => boolean; now?: () => number } = {},
) {
  const sleeps: number[] = []
  const store = createChatStore({
    connect: (directory) =>
      openChat(directory, {
        bridge: server.bridge,
        admit: async () => (extra.trusted?.() ?? true ? { ok: true } : { ok: false, problem: "Il progetto è cambiato e non ti fidi più." }),
        now: extra.now ?? (() => 0),
      }),
    sleep: async (ms) => {
      sleeps.push(ms)
      await tick(1)
    },
    random: () => 0,
    ...extra,
  })
  return { store, sleeps }
}

async function live(server: ReturnType<typeof fakeServer>, store: ReturnType<typeof createChatStore>, streams = 1) {
  await until("lo stream", () => server.streams.length === streams)
  server.stream().push({ type: "server.connected", properties: {} })
  await until("live", () => store.state.status === "live")
}

describe("the chat's store", () => {
  test("nothing is called before open; open loads the folder after server.connected, then follows its events", async () => {
    const server = fakeServer()
    const { store } = storeOn(server)
    expect(server.sent).toEqual([])
    expect(store.state.status).toBe("idle")
    await store.open(A)
    await until("lo stream", () => server.streams.length === 1)
    // Stream first, the load only when the server says it is connected.
    expect(server.calls("GET", /^\/session$/)).toHaveLength(0)
    expect(server.stream().directory).toBe(A)
    await live(server, store)
    expect(store.state.data.session.map((s) => s.id)).toEqual(["ses_1"])
    server.stream().push({ type: "message.updated", properties: { info: assistant("msg_1") } })
    server.stream().push({ type: "message.part.updated", properties: { part: textPart("prt_1", "msg_1", "Ciao") } })
    await until("il messaggio", () => store.state.data.part.msg_1?.length === 1)
    expect(store.state.data.message.ses_1!.map((m) => m.id)).toEqual(["msg_1"])
  })

  test("leaving the Chat section does not stop the answer: the view goes, the stream stays", async () => {
    const server = fakeServer()
    const { store } = storeOn(server)
    await store.open(A)
    await live(server, store)
    server.stream().push({ type: "message.updated", properties: { info: assistant("msg_1") } })
    server.stream().push({ type: "message.part.updated", properties: { part: textPart("prt_1", "msg_1", "Il mare") } })
    // The view: a root that reads the store, disposed as when the section changes.
    const seen: string[] = []
    const dispose = createRoot((dispose) => {
      createEffect(() => {
        const part = store.state.data.part.msg_1?.[0] as { text?: string } | undefined
        if (part?.text) seen.push(part.text)
      })
      return dispose
    })
    await until("la vista legge", () => seen.includes("Il mare"))
    dispose()
    server.stream().push({ type: "message.part.updated", properties: { part: textPart("prt_1", "msg_1", "Il mare d'inverno") } })
    server.stream().push({ type: "message.part.updated", properties: { part: textPart("prt_1", "msg_1", "Il mare d'inverno è grigio.") } })
    await until("la risposta completa", () => (store.state.data.part.msg_1?.[0] as { text?: string }).text === "Il mare d'inverno è grigio.")
    expect(seen).toEqual(["Il mare"])
    expect(server.streams).toHaveLength(1)
    expect(server.aborted).toEqual([])
    expect(store.state.status).toBe("live")
  })

  test("requests waiting when the stream opens, or asked while it was down, are loaded; answered ones go", async () => {
    const server = fakeServer()
    server.routes.permissions = [{ id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["npm test"], metadata: {}, always: [] }]
    server.routes.questions = [{ id: "que_1", sessionID: "ses_1", questions: [] }]
    const { store } = storeOn(server)
    await store.open(A)
    await live(server, store)
    expect(store.state.data.permission.ses_1!.map((p) => p.id)).toEqual(["per_1"])
    expect(store.state.data.question.ses_1!.map((q) => q.id)).toEqual(["que_1"])

    // The stream goes down; meanwhile the first is answered elsewhere and a new one is asked.
    server.stream().end()
    server.routes.permissions = [{ id: "per_2", sessionID: "ses_1", permission: "edit", patterns: ["a.ts"], metadata: {}, always: [] }]
    server.routes.questions = []
    await live(server, store, 2)
    expect(store.state.data.permission.ses_1!.map((p) => p.id)).toEqual(["per_2"])
    expect(store.state.data.question.ses_1).toBeUndefined()
  })

  test("an event the chat cannot read is skipped: the stream stays, the next event is applied", async () => {
    const server = fakeServer()
    const { store, sleeps } = storeOn(server)
    await store.open(A)
    await live(server, store)
    server.stream().push({ type: "message.updated", properties: {} })
    server.stream().push({ type: "message.part.updated", properties: { part: null } })
    server.stream().push({ type: "message.updated", properties: { info: assistant("msg_1") } })
    await until("il messaggio dopo", () => store.state.data.message.ses_1?.length === 1)
    expect(server.streams).toHaveLength(1)
    expect(server.aborted).toEqual([])
    expect(sleeps).toEqual([])
    expect(store.state.status).toBe("live")
  })

  test("an event that arrives while the folder loads is not undone by the older list", async () => {
    const server = fakeServer()
    let open!: () => void
    server.routes.statusGate = new Promise((resolve) => (open = resolve))
    // The server read its status list before the answer started.
    server.routes.status = {}
    const { store } = storeOn(server)
    await store.open(A)
    await until("lo stream", () => server.streams.length === 1)
    server.stream().push({ type: "server.connected", properties: {} })
    await until("il caricamento", () => server.calls("GET", /^\/session\/status$/).length === 1)
    server.stream().push({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } })
    await until("occupata", () => store.state.data.session_status.ses_1?.type === "busy")
    open()
    await until("live", () => store.state.status === "live")
    expect(store.state.data.session_status.ses_1).toEqual({ type: "busy" })
  })

  test("opening the folder already open changes nothing", async () => {
    const server = fakeServer()
    const { store } = storeOn(server)
    await store.open(A)
    await live(server, store)
    await store.open(A)
    await tick(10)
    expect(server.streams).toHaveLength(1)
  })

  test("a stream that ends, falls silent or sends server.error is reopened after a growing wait, and loaded again", async () => {
    const server = fakeServer()
    const { store, sleeps } = storeOn(server, { silenceMs: 40, backoffMs: [100, 200, 400] })
    await store.open(A)
    await store.loadMessages("ses_1")
    await live(server, store)
    const loads = () => server.calls("GET", /^\/session$/).length
    const messageLoads = () => server.calls("GET", /^\/session\/ses_1\/message$/).length
    expect(loads()).toBe(1)
    expect(messageLoads()).toBe(2)

    // Closed by the server.
    server.stream().end()
    await live(server, store, 2)
    expect(loads()).toBe(2)
    expect(messageLoads()).toBe(3)

    // server.error: the server dropped a client too far behind.
    server.stream().push({ type: "server.error", properties: { message: "lag" } })
    await live(server, store, 3)

    // Silence past silenceMs.
    await until("il silenzio", () => server.streams.length === 4, 1000)
    expect(sleeps).toEqual([100, 100, 100])
    // Each abandoned stream closed on the server's side too.
    expect(server.aborted).toEqual(expect.arrayContaining([server.streams[1]!.id, server.streams[2]!.id]))
  })

  test("waits grow while the server stays away", async () => {
    const server = fakeServer()
    const { store, sleeps } = storeOn(server, { backoffMs: [100, 200, 400] })
    await store.open(A)
    for (let n = 1; n <= 4; n++) {
      await until(`stream ${n}`, () => server.streams.length === n)
      server.stream().end()
    }
    await until("quattro attese", () => sleeps.length >= 4)
    expect(sleeps.slice(0, 4)).toEqual([100, 200, 400, 400])
    expect(store.state.status).toBe("retrying")
    store.close()
  })

  test("close during the stream: its server side closed once, nothing sent after", async () => {
    const server = fakeServer()
    const { store } = storeOn(server)
    await store.open(A)
    await live(server, store)
    const before = server.sent.length
    store.close()
    await tick(20)
    expect(server.aborted).toEqual([server.stream().id])
    expect(server.sent).toHaveLength(before)
    expect(store.state.status).toBe("idle")
  })

  test("another folder mid-answer: this one's stream closes, the answer is not stopped, and is found on return", async () => {
    const server = fakeServer()
    const { store } = storeOn(server)
    await store.open(A)
    await store.loadMessages("ses_1")
    await live(server, store)
    server.stream().push({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } })
    await store.open(B)
    await until("lo stream di B", () => server.streams.length === 2)
    expect(server.streams[1]!.directory).toBe(B)
    expect(server.calls("POST", /\/abort$/)).toEqual([])
    expect(store.state.data.message).toEqual({})

    // Meanwhile A's answer finished on the server.
    server.routes.messages.ses_1 = [{ info: assistant("msg_1"), parts: [textPart("prt_1", "msg_1", "Fatto.")] }]
    await store.open(A)
    await store.loadMessages("ses_1")
    expect((store.state.data.part.msg_1?.[0] as { text?: string }).text).toBe("Fatto.")
  })

  test("a folder refused at the opening sends nothing", async () => {
    const server = fakeServer()
    const { store } = storeOn(server, { trusted: () => false })
    await store.open(A)
    expect(store.state.status).toBe("refused")
    expect(store.state.problem).toBe("Il progetto è cambiato e non ti fidi più.")
    expect(server.sent).toEqual([])
  })

  test("a connection that throws leaves the folder refused, with why, and opening it again tries again", async () => {
    const server = fakeServer()
    let fail = true
    const failing = createChatStore({
      connect: async (directory) => {
        if (fail) throw new Error("Il server di ADE non è partito.")
        return openChat(directory, { bridge: server.bridge, admit: async () => ({ ok: true }), now: () => 0 })
      },
      sleep: async () => void (await tick(1)),
      random: () => 0,
    })
    await failing.open(A)
    expect(failing.state.status).toBe("refused")
    expect(failing.state.problem).toBe("Il server di ADE non è partito.")
    expect(server.sent).toEqual([])
    fail = false
    await failing.open(A)
    await live(server, failing)
    expect(failing.state.data.session.map((s) => s.id)).toEqual(["ses_1"])
  })

  test("trust refused on a reconnection: final, no more requests and no retry", async () => {
    const server = fakeServer()
    let trusted = true
    let clock = 0
    const { store, sleeps } = storeOn(server, { trusted: () => trusted, now: () => clock })
    await store.open(A)
    await live(server, store)
    trusted = false
    clock += 60_000
    server.stream().end()
    await until("rifiutata", () => store.state.status === "refused")
    const after = server.sent.length
    await tick(30)
    expect(server.sent).toHaveLength(after)
    expect(sleeps).toEqual([1_000])
    expect(store.state.problem).toBe("Il progetto è cambiato e non ti fidi più.")
  })

  test("send makes a session when there is none, and always names the model", async () => {
    const server = fakeServer()
    const { store } = storeOn(server)
    await store.open(A)
    await live(server, store)
    const id = await store.send(undefined, "Ciao", FREE)
    expect(id).toBe("ses_nuova")
    const prompt = server.calls("POST", /\/prompt_async$/)
    expect(prompt).toHaveLength(1)
    expect(prompt[0]!.path.split("?")[0]).toBe("/session/ses_nuova/prompt_async")
    expect(JSON.parse(prompt[0]!.body!)).toMatchObject({ parts: [{ type: "text", text: "Ciao" }], model: FREE })
    await store.abort(id)
    expect(server.calls("POST", /^\/session\/ses_nuova\/abort$/)).toHaveLength(1)
  })
})
