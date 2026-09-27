import { describe, expect, test } from "bun:test"
import { t } from "../i18n"
import { createRoot, createEffect } from "solid-js"
import { openChat } from "./connection"
import { CHAT_PERMISSION } from "./rules"
import { createChatStore, ForeignSession, titleFrom, type ChatStoreDeps } from "./store"
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
const textPart = (id: string, messageID: string, text: string) => ({
  id,
  messageID,
  sessionID: "ses_1",
  type: "text",
  text,
})

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
    /** The catalog (`/config/providers`): the free model the tests send, on OpenRouter, which the server can run. */
    providers: {
      providers: [
        {
          id: "openrouter",
          name: "OpenRouter",
          models: { [FREE.modelID]: { id: FREE.modelID, providerID: "openrouter" } },
        },
      ],
      default: {},
    } as object | undefined,
  }
  const reply = (onEvent: (event: ProxyEvent) => void, status: number, body?: unknown) =>
    setTimeout(() => {
      onEvent({ kind: "head", status, headers: [["content-type", "application/json"]] })
      if (body !== undefined) onEvent({ kind: "chunk", bytes: bytes(JSON.stringify(body)) })
      onEvent({ kind: "end" })
    }, 1)
  const bridge: ServerBridge = {
    async start() {
      return { url: "http://127.0.0.1:49374", version: "1.389.0" }
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
          push: (event) =>
            void head.then(
              () => open && onEvent({ kind: "chunk", bytes: bytes(`data: ${JSON.stringify(event)}\n\n`) }),
            ),
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
      } else if (request.method === "GET" && path === "/config/providers") {
        if (routes.providers) reply(onEvent, 200, routes.providers)
        else reply(onEvent, 500, { error: "catalogo non disponibile" })
      } else if (request.method === "GET" && path === "/agent")
        reply(onEvent, 200, [{ name: "build", mode: "primary" }])
      else if (request.method === "GET" && path === "/config") reply(onEvent, 200, { model: "openrouter/x:free" })
      else if (request.method === "GET" && path === "/permission") reply(onEvent, 200, routes.permissions)
      else if (request.method === "GET" && path === "/question") reply(onEvent, 200, routes.questions)
      else if (request.method === "POST" && /^\/(permission|question)\/[^/]+\/(reply|reject)$/.test(path))
        reply(onEvent, 200, true)
      else if (request.method === "GET" && /^\/session\/[^/]+\/message$/.test(path)) {
        reply(onEvent, 200, routes.messages[path.split("/")[2]!] ?? [])
      } else if (request.method === "POST" && path === "/session") {
        // As the server does: the session keeps the rules it was made with.
        reply(onEvent, 200, { ...session("ses_nuova"), permission: JSON.parse(request.body ?? "{}").permission })
      } else if (request.method === "PATCH" && /^\/session\/[^/]+$/.test(path)) {
        const id = path.split("/")[2]!
        const found = routes.sessions.find((s) => (s as { id: string }).id === id)
        if (!found) reply(onEvent, 404, { error: "non trovata" })
        else
          reply(onEvent, 200, {
            ...found,
            title: JSON.parse(request.body ?? "{}").title,
            time: { created: 1, updated: 9 },
          })
      } else if (request.method === "POST" && path.endsWith("/prompt_async")) reply(onEvent, 204)
      else if (request.method === "POST" && path.endsWith("/abort")) reply(onEvent, 200, true)
      else if (request.method === "GET" && path === "/find/file") reply(onEvent, 200, ["src/app.ts", "src/api.ts"])
      else reply(onEvent, 404, { error: "non previsto" })
      return id
    },
    async abort(id) {
      aborted.push(id)
    },
  }
  const stream = () => streams.at(-1)!
  const calls = (method: string, path: RegExp) =>
    sent.filter((r) => r.method === method && path.test(r.path.split("?")[0]!))
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
        admit: async () =>
          (extra.trusted?.() ?? true)
            ? { ok: true }
            : { ok: false, problem: "Il progetto è cambiato e non ti fidi più." },
        now: extra.now ?? (() => 0),
      }),
    sleep: async (ms) => {
      sleeps.push(ms)
      await tick(1)
    },
    random: () => 0,
    checkAttachment: async () => "ok",
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
    server
      .stream()
      .push({ type: "message.part.updated", properties: { part: textPart("prt_1", "msg_1", "Il mare d'inverno") } })
    server.stream().push({
      type: "message.part.updated",
      properties: { part: textPart("prt_1", "msg_1", "Il mare d'inverno è grigio.") },
    })
    await until(
      "la risposta completa",
      () => (store.state.data.part.msg_1?.[0] as { text?: string }).text === "Il mare d'inverno è grigio.",
    )
    expect(seen).toEqual(["Il mare"])
    expect(server.streams).toHaveLength(1)
    expect(server.aborted).toEqual([])
    expect(store.state.status).toBe("live")
  })

  test("requests waiting when the stream opens, or asked while it was down, are loaded; answered ones go", async () => {
    const server = fakeServer()
    server.routes.permissions = [
      { id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["npm test"], metadata: {}, always: [] },
    ]
    server.routes.questions = [{ id: "que_1", sessionID: "ses_1", questions: [] }]
    const { store } = storeOn(server)
    await store.open(A)
    await live(server, store)
    expect(store.state.data.permission.ses_1!.map((p) => p.id)).toEqual(["per_1"])
    expect(store.state.data.question.ses_1!.map((q) => q.id)).toEqual(["que_1"])

    // The stream goes down; meanwhile the first is answered elsewhere and a new one is asked.
    server.stream().end()
    server.routes.permissions = [
      { id: "per_2", sessionID: "ses_1", permission: "edit", patterns: ["a.ts"], metadata: {}, always: [] },
    ]
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

  test("a message sent while another folder opens stays the first folder's", async () => {
    const server = fakeServer()
    const { store } = storeOn(server)
    await store.open(A)
    await live(server, store)
    // The new session is being made on A when B opens.
    const sending = store.send(undefined, "Ciao", FREE)
    const opening = store.open(B)
    expect(await sending).toBe("ses_nuova")
    await opening
    await live(server, store, 2)
    const on = (request: ProxyRequest) =>
      decodeURIComponent(request.headers.find(([name]) => name.toLowerCase() === "x-nikcli-directory")?.[1] ?? "")
    expect(server.calls("POST", /\/prompt_async$/).map(on)).toEqual([A])
    expect(server.calls("GET", /^\/session\/ses_nuova\/message$/).filter((r) => on(r) === B)).toEqual([])
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
    // Made with the chat's permission rules, which win over the agent's.
    const created = server.calls("POST", /^\/session$/)
    expect(JSON.parse(created[0]!.body!).permission).toEqual(CHAT_PERMISSION)
    // And a second message to it goes, before its event has even arrived.
    await store.send(id, "Ancora", FREE)
    expect(server.calls("POST", /\/prompt_async$/)).toHaveLength(2)
    const prompt = server.calls("POST", /\/prompt_async$/)
    expect(prompt[0]!.path.split("?")[0]).toBe("/session/ses_nuova/prompt_async")
    expect(JSON.parse(prompt[0]!.body!)).toMatchObject({ parts: [{ type: "text", text: "Ciao" }], model: FREE })
    await store.abort(id)
    expect(server.calls("POST", /^\/session\/ses_nuova\/abort$/)).toHaveLength(1)
  })

  /* Composer-chip, pezzo 3: the effort chip's level goes with the message only when the model has it. */
  test("the effort is sent as the variant only when the model has that level", async () => {
    const server = fakeServer()
    server.routes.providers = {
      providers: [
        {
          id: "openrouter",
          name: "OpenRouter",
          models: {
            [FREE.modelID]: { id: FREE.modelID, providerID: "openrouter", variants: { none: {}, thinking: {} } },
          },
        },
      ],
      default: {},
    }
    const { store } = storeOn(server)
    await store.open(A)
    await live(server, store)
    const id = await store.send(undefined, "Pensa", FREE, undefined, [], "thinking")
    await store.send(id, "Forte", FREE, undefined, [], "high")
    await store.send(id, "Normale", FREE)
    const bodies = server.calls("POST", /\/prompt_async$/).map((call) => JSON.parse(call.body!) as { variant?: string })
    expect(bodies.map((body) => body.variant)).toEqual(["thinking", undefined, undefined])
  })

  /* A model the server does not have: said before anything is sent, not a turn that never answers. */
  test("a model missing from the catalog, or whose provider is not connected, is refused before anything is sent", async () => {
    const server = fakeServer()
    const { store } = storeOn(server)
    await store.open(A)
    await live(server, store)
    const gone = { providerID: "openrouter", modelID: "nex-agi/nex-n2.5-mini:free" }
    const refused = await store.send(undefined, "Ciao", gone).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toBe(t("chat.model.missing", "openrouter/nex-agi/nex-n2.5-mini:free"))
    const elsewhere = { providerID: "anthropic", modelID: "claude-x" }
    const notConnected = await store.send("ses_1", "Ciao", elsewhere).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect((notConnected as Error).message).toBe(t("chat.model.missing", "anthropic/claude-x"))
    expect(server.calls("POST", /^\/session$/)).toHaveLength(0)
    expect(server.calls("POST", /\/prompt_async$/)).toHaveLength(0)
    // The one it has goes.
    expect(await store.send(undefined, "Ciao", FREE)).toBe("ses_nuova")
  })

  /* Modello assente review, M2: a provider connected while the Chat is open is not refused. */
  test("before refusing, the catalog is read again: a provider connected meanwhile counts", async () => {
    const server = fakeServer()
    const { store } = storeOn(server)
    await store.open(A)
    await live(server, store)
    await store.catalog()
    const later = { providerID: "anthropic", modelID: "claude-x" }
    // Connected after the catalog was read.
    server.routes.providers = {
      providers: [
        {
          id: "openrouter",
          name: "OpenRouter",
          models: { [FREE.modelID]: { id: FREE.modelID, providerID: "openrouter" } },
        },
        { id: "anthropic", name: "Anthropic", models: { "claude-x": { id: "claude-x", providerID: "anthropic" } } },
      ],
      default: {},
    }
    expect(await store.send(undefined, "Ciao", later)).toBe("ses_nuova")
    // One read at the opening and one before the refusal that did not happen; the model it had goes with no new read.
    expect(server.calls("GET", /^\/config\/providers$/)).toHaveLength(2)
    await store.send(undefined, "Ancora", FREE)
    expect(server.calls("GET", /^\/config\/providers$/)).toHaveLength(2)
  })

  test("a catalog that cannot be read does not stop the message: the server decides", async () => {
    const server = fakeServer()
    server.routes.providers = undefined
    const { store } = storeOn(server)
    await store.open(A)
    await live(server, store)
    expect(await store.send(undefined, "Ciao", { providerID: "openrouter", modelID: "qualunque:free" })).toBe(
      "ses_nuova",
    )
    expect(server.calls("POST", /\/prompt_async$/)).toHaveLength(1)
  })

  /* C5: the chat's rules, and the answers that reach the server. */
  test("a session made elsewhere gets nothing: its rules are not the chat's", async () => {
    const server = fakeServer()
    server.routes.sessions = [session("ses_1"), { ...session("ses_2"), permission: [...CHAT_PERMISSION] }]
    const { store } = storeOn(server)
    await store.open(A)
    await live(server, store)
    const refused = await store.send("ses_1", "rm -rf build", FREE).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(refused).toBeInstanceOf(ForeignSession)
    expect(server.calls("POST", /\/prompt_async$/)).toEqual([])
    // One the chat made, listed by the server, is fine.
    await store.send("ses_2", "Ciao", FREE)
    expect(server.calls("POST", /\/prompt_async$/).map((r) => r.path.split("?")[0])).toEqual([
      "/session/ses_2/prompt_async",
    ])
  })

  test("a session made elsewhere is neither renamed nor stopped: nothing reaches the server", async () => {
    const server = fakeServer()
    const { store } = storeOn(server)
    await store.open(A)
    await live(server, store)
    const renamed = await store.rename("ses_1", "Mio").then(
      () => undefined,
      (error: unknown) => error,
    )
    const stopped = await store.abort("ses_1").then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(renamed).toBeInstanceOf(ForeignSession)
    expect(stopped).toBeInstanceOf(ForeignSession)
    expect(server.calls("PATCH", /^\/session\//)).toEqual([])
    expect(server.calls("POST", /\/abort$/)).toEqual([])
    expect(store.state.data.session.find((s) => s.id === "ses_1")?.title).not.toBe("Mio")
  })

  test("yes this once, no, an answer and a declined question reach the server as sent", async () => {
    const server = fakeServer()
    const { store } = storeOn(server)
    await store.open(A)
    await live(server, store)
    await store.replyPermission("per_1", "once")
    await store.replyPermission("per_2", "reject")
    await store.answerQuestion("que_1", [["Sì"], ["rosso", "blu"]])
    await store.rejectQuestion("que_2")
    const posts = server.sent
      .filter((r) => r.method === "POST")
      .map((r) => [r.path.split("?")[0], JSON.parse(r.body || "null")])
    expect(posts).toEqual([
      ["/permission/per_1/reply", { reply: "once" }],
      ["/permission/per_2/reply", { reply: "reject" }],
      ["/question/que_1/reply", { answers: [["Sì"], ["rosso", "blu"]] }],
      ["/question/que_2/reject", null],
    ])
  })

  /* C4: the sessions the chat lists, opens, starts and renames. */
  test("a message goes with the agent chosen; without one, the server's default", async () => {
    const server = fakeServer()
    const { store } = storeOn(server)
    await store.open(A)
    await live(server, store)
    const id = await store.send(undefined, "Ciao", FREE, "plan")
    await store.send(id, "Ancora", FREE)
    const bodies = server.calls("POST", /\/prompt_async$/).map((r) => JSON.parse(r.body!))
    expect(bodies[0]).toMatchObject({ model: FREE, agent: "plan" })
    expect(bodies[1]).toMatchObject({ model: FREE })
    expect("agent" in bodies[1]).toBe(false)
  })

  test("a rename reaches the server and shows at once; an empty title sends nothing", async () => {
    const server = fakeServer()
    server.routes.sessions = [{ ...session("ses_1"), permission: [...CHAT_PERMISSION] }]
    const { store } = storeOn(server)
    await store.open(A)
    await live(server, store)
    await store.rename("ses_1", "  Il piano del lunedì  ")
    const patch = server.calls("PATCH", /^\/session\/ses_1$/)
    expect(patch.map((r) => JSON.parse(r.body!))).toEqual([{ title: "Il piano del lunedì" }])
    expect(store.state.data.session.find((s) => s.id === "ses_1")?.title).toBe("Il piano del lunedì")
    const empty = await store.rename("ses_1", "   ").then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(empty).toBeInstanceOf(Error)
    expect(server.calls("PATCH", /^\/session\//)).toHaveLength(1)
  })

  /* C6: files go with the text, and only the folder's. */
  test("a message goes with the project's files it names", async () => {
    const server = fakeServer()
    const { store } = storeOn(server)
    await store.open(A)
    await live(server, store)
    const file = {
      type: "file" as const,
      mime: "text/plain",
      url: "file:///C:/progetto-a/src/app.ts",
      filename: "app.ts",
    }
    await store.send(undefined, "Guarda @src/app.ts", FREE, undefined, [file])
    const body = JSON.parse(server.calls("POST", /\/prompt_async$/)[0]!.body!)
    expect(body.parts).toEqual([{ type: "text", text: "Guarda @src/app.ts" }, file])
  })

  test("a file outside the folder: nothing is sent, not even the session", async () => {
    const server = fakeServer()
    const { store } = storeOn(server)
    await store.open(A)
    await live(server, store)
    for (const url of [
      "file:///C:/Users/me/.ssh/id_ed25519",
      "file:///C:/progetto-a/../progetto-b/x.ts",
      "file:///C:/progetto-a-vecchio/x.ts",
      "file:///D:/progetto-a/x.ts",
      "file://server/share/x.ts",
      "https://example.test/x.ts",
    ]) {
      const refused = await store
        .send(undefined, "Leggi", FREE, undefined, [{ type: "file", mime: "text/plain", url }])
        .then(
          () => undefined,
          (error: unknown) => error,
        )
      expect([url, refused instanceof Error]).toEqual([url, true])
    }
    expect(server.calls("POST", /^\/session$/)).toEqual([])
    expect(server.calls("POST", /\/prompt_async$/)).toEqual([])
  })

  test("a file that Rust finds outside once links are followed: nothing is sent", async () => {
    const server = fakeServer()
    const asked: [string, string][] = []
    const { store } = storeOn(server, {
      checkAttachment: async (root, path) => {
        asked.push([root, path])
        return path.endsWith("note.txt") ? "outside" : path.endsWith("src") ? "notFile" : "ok"
      },
    })
    await store.open(A)
    await live(server, store)
    // A junction or a link inside the folder, aimed at ~/.ssh: inside as written, outside once followed.
    const linked = { type: "file" as const, mime: "text/plain", url: "file:///C:/progetto-a/note.txt" }
    const refused = await store.send(undefined, "Leggi", FREE, undefined, [linked]).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toBe(t("chat.attach.outside", "C:/progetto-a/note.txt"))
    expect(asked).toEqual([[A, "C:/progetto-a/note.txt"]])
    const folder = { type: "file" as const, mime: "text/plain", url: "file:///C:/progetto-a/src" }
    expect(
      await store.send(undefined, "Leggi", FREE, undefined, [folder]).then(
        () => "sent",
        () => "refused",
      ),
    ).toBe("refused")
    expect(server.calls("POST", /^\/session$/)).toEqual([])
    expect(server.calls("POST", /\/prompt_async$/)).toEqual([])
  })

  test("a .env is refused with its reason, by its name or by what Rust finds it is", async () => {
    const server = fakeServer()
    const { store } = storeOn(server, {
      checkAttachment: async (_root, path) => (path.endsWith("note.txt") ? "env" : "ok"),
    })
    await store.open(A)
    await live(server, store)
    const byName = { type: "file" as const, mime: "text/plain", url: "file:///C:/progetto-a/.env.local" }
    const named = await store.send(undefined, "Leggi", FREE, undefined, [byName]).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect((named as Error).message).toBe(t("chat.attach.env", "C:/progetto-a/.env.local"))
    const linked = { type: "file" as const, mime: "text/plain", url: "file:///C:/progetto-a/note.txt" }
    const followed = await store.send(undefined, "Leggi", FREE, undefined, [linked]).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect((followed as Error).message).toBe(t("chat.attach.env", "C:/progetto-a/note.txt"))
    expect(server.calls("POST", /\/prompt_async$/)).toEqual([])
  })

  test("without Rust's check, a file is refused: the store does not guess", async () => {
    const server = fakeServer()
    const { store } = storeOn(server, { checkAttachment: undefined })
    await store.open(A)
    await live(server, store)
    const file = { type: "file" as const, mime: "text/plain", url: "file:///C:/progetto-a/src/app.ts" }
    expect(
      await store.send(undefined, "Leggi", FREE, undefined, [file]).then(
        () => "sent",
        () => "refused",
      ),
    ).toBe("refused")
    expect(server.calls("POST", /\/prompt_async$/)).toEqual([])
  })

  test("@ looks the folder's files up on the server", async () => {
    const server = fakeServer()
    const { store } = storeOn(server)
    await store.open(A)
    await live(server, store)
    expect(await store.findFiles("ap")).toEqual(["src/app.ts", "src/api.ts"])
    const query = new URLSearchParams(server.calls("GET", /^\/find\/file$/)[0]!.path.split("?")[1])
    expect([query.get("query"), query.get("type")]).toEqual(["ap", "file"])
  })

  test("a new session is made with a title, so no model is called to name it", async () => {
    const server = fakeServer()
    const { store } = storeOn(server)
    await store.open(A)
    await live(server, store)
    await store.send(undefined, "  Spiegami   il file\nconnection.ts, per favore", FREE)
    const created = JSON.parse(server.calls("POST", /^\/session$/)[0]!.body!)
    expect(created.title).toBe("Spiegami il file")
    // Not nikcli's default («New session - <ISO date>»), which it would title with its small model.
    expect(created.title).not.toMatch(/^(New session|Child session) - \d{4}-/)
    expect(titleFrom("x".repeat(80))).toBe(`${"x".repeat(59)}…`)
  })

  test("the catalog comes through the folder's own connection, once per opening", async () => {
    const server = fakeServer()
    let connects = 0
    const { store } = storeOn(server, {
      connect: (directory) => {
        connects++
        return openChat(directory, { bridge: server.bridge, admit: async () => ({ ok: true }), now: () => 0 })
      },
    })
    const before = await store.catalog().then(
      () => "caricato",
      (error: unknown) => error,
    )
    // Not open: nothing to load it through, and nothing is called.
    expect(before).toBeInstanceOf(Error)
    expect(server.sent).toEqual([])
    await store.open(A)
    await live(server, store)
    const [one, two] = await Promise.all([store.catalog(), store.catalog()])
    expect(one).toEqual(two)
    expect(one.configModel).toBe("openrouter/x:free")
    expect(one.agents?.map((agent) => agent.name)).toEqual(["build"])
    expect(connects).toBe(1)
    const catalog = [
      ...server.calls("GET", /^\/config\/providers$/),
      ...server.calls("GET", /^\/agent$/),
      ...server.calls("GET", /^\/config$/),
    ]
    expect(catalog).toHaveLength(3)
    for (const request of catalog) {
      expect(
        decodeURIComponent(request.headers.find(([name]) => name.toLowerCase() === "x-nikcli-directory")?.[1] ?? ""),
      ).toBe(A)
    }
  })
})
