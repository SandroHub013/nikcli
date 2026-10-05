import { describe, expect, test } from "bun:test"
import type { ModHostEvent } from "@nikcli-ai/ui/mod-tree-model"
import type { ChatConnection } from "../../chat/connection"
import { adeModSource } from "./mods-source"

type Open = Extract<ChatConnection, { ok: true }>

const sse = (...events: object[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")

/** A folder's event stream: each body is one connection, and a body that is a status ends in a refusal. */
function stream(bodies: Array<string | number>) {
  const requests: Request[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init))
    const next = bodies[Math.min(requests.length - 1, bodies.length - 1)]!
    if (typeof next === "number") return new Response("no", { status: next })
    return new Response(next, { status: 200, headers: { "content-type": "text/event-stream" } })
  }) as unknown as typeof globalThis.fetch
  return { fetch, requests }
}

function connection(fetch: typeof globalThis.fetch, mod: Record<string, unknown> = {}): Open {
  return { ok: true, directory: "/work/app", fetch, client: { mod } as unknown as Open["client"] }
}

const until = async (done: () => boolean, ms = 1000) => {
  const deadline = Date.now() + ms
  while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(done()).toBe(true)
}

describe("adeModSource", () => {
  test("asks the mods to draw for the ade surface", async () => {
    const calls: unknown[] = []
    const { fetch } = stream([sse({ type: "server.connected", properties: {} })])
    const source = adeModSource(
      connection(fetch, {
        render: async (input: unknown) => {
          calls.push(input)
          return { data: { kind: "tree", tree: "null" } }
        },
      }),
    )
    try {
      expect(source.surface).toBe("ade")
      const out = await source.render({ component: "Pane", requestId: "p1", props: { title: "T" } })
      expect(out).toEqual({ kind: "tree", tree: "null" })
      expect(calls).toEqual([
        { component: "Pane", requestId: "p1", sessionID: undefined, props: '{"title":"T"}', surface: "ade" },
      ])
    } finally {
      source.close()
    }
  })

  test("passes on mod.ui events of the folder, and turns a connect into an invalidation", async () => {
    const { fetch, requests } = stream([
      sse(
        { type: "server.connected", properties: {} },
        { type: "message.updated", properties: {} },
        { type: "mod.ui.panes", properties: {} },
        { type: "mod.ui.invalidate", properties: { component: "Pane", requestID: "p1" } },
      ),
      403,
    ])
    const source = adeModSource(connection(fetch), 5)
    const seen: ModHostEvent[] = []
    const off = source.subscribe((event) => seen.push(event))
    try {
      await until(() => seen.length >= 3)
      expect(seen).toEqual([
        { type: "mod.ui.invalidate", properties: {} },
        { type: "mod.ui.panes", properties: {} },
        { type: "mod.ui.invalidate", properties: { component: "Pane", requestID: "p1" } },
      ])
      // The folder's own stream: its directory goes in the header, percent-encoded.
      expect(requests[0]!.headers.get("x-nikcli-directory")).toBe(encodeURIComponent("/work/app"))
    } finally {
      off()
      source.close()
    }
  })

  test("reads the stream again after it drops, and stops after a refusal", async () => {
    const { fetch, requests } = stream([
      sse({ type: "server.connected", properties: {} }),
      sse({ type: "server.connected", properties: {} }),
      403,
    ])
    const source = adeModSource(connection(fetch), 5)
    const seen: ModHostEvent[] = []
    source.subscribe((event) => seen.push(event))
    try {
      await until(() => requests.length >= 3)
      // The 403 is a no: it is not asked a fourth time.
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(requests.length).toBe(3)
      expect(seen.filter((event) => event.type === "mod.ui.invalidate").length).toBe(2)
    } finally {
      source.close()
    }
  })

  test("close stops the stream", async () => {
    const { fetch, requests } = stream([sse({ type: "server.connected", properties: {} })])
    const source = adeModSource(connection(fetch), 5)
    await until(() => requests.length >= 2)
    source.close()
    const after = requests.length
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(requests.length).toBeLessThanOrEqual(after + 1)
  })

  test("unsubscribing stops delivery to that listener only", async () => {
    const { fetch } = stream([sse({ type: "server.connected", properties: {} })])
    const source = adeModSource(connection(fetch), 5)
    const first: ModHostEvent[] = []
    const second: ModHostEvent[] = []
    const offFirst = source.subscribe((event) => first.push(event))
    source.subscribe((event) => second.push(event))
    offFirst()
    try {
      await until(() => second.length > 0)
      expect(first).toEqual([])
    } finally {
      source.close()
    }
  })
})
