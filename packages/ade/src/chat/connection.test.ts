import { describe, expect, test } from "bun:test"
import { isChatRefused, openChat } from "./connection"
import type { ProxyEvent, ProxyRequest, ServerBridge } from "./transport"

/*
 * C2, from the C1 review (M1): a chat on a folder makes the server load that
 * folder's `.nikcli/`, plugins included. The folder is admitted first, as the
 * Bots do; until then nothing leaves, and the client stays on that folder.
 */

const bytes = (text: string) => Array.from(new TextEncoder().encode(text))
const PROJECT = "C:/progetto"

function fakeBridge() {
  const starts: (string | undefined)[] = []
  const sent: ProxyRequest[] = []
  const bridge: ServerBridge = {
    async start(directory) {
      starts.push(directory)
      return { url: "http://127.0.0.1:49374", version: "1.389.0", shared: true }
    },
    async send(request, onEvent: (event: ProxyEvent) => void) {
      sent.push(request)
      queueMicrotask(() => {
        onEvent({ kind: "head", status: 200, headers: [["content-type", "application/json"]] })
        onEvent({ kind: "chunk", bytes: bytes("[]") })
        onEvent({ kind: "end" })
      })
      return sent.length
    },
    async abort() {},
  }
  return { bridge, starts, sent }
}

describe("the chat on a folder", () => {
  test("a folder the user did not admit gets no request at all, the server's start included", async () => {
    const fake = fakeBridge()
    const asked: string[] = []
    const opened = await openChat(PROJECT, {
      bridge: fake.bridge,
      admit: async (directory) => {
        asked.push(directory)
        return { ok: false, problem: "Non ti fidi di questo progetto." }
      },
    })
    expect(opened).toEqual({ ok: false, problem: "Non ti fidi di questo progetto." })
    expect(asked).toEqual([PROJECT])
    expect(fake.starts).toEqual([])
    expect(fake.sent).toEqual([])
  })

  test("admitted, the requests carry that folder, and the server starts there", async () => {
    const fake = fakeBridge()
    const opened = await openChat(PROJECT, { bridge: fake.bridge, admit: async () => ({ ok: true }) })
    if (!opened.ok) throw new Error("non aperta")
    await opened.client.session.list({ roots: true })
    expect(fake.starts).toEqual([PROJECT])
    expect(fake.sent).toHaveLength(1)
    const headers = new Map(fake.sent[0]!.headers.map(([name, value]) => [name.toLowerCase(), value]))
    expect(headers.get("x-nikcli-directory")).toBe(PROJECT)
  })

  test("a request for another folder, in the header or the query, does not leave", async () => {
    const fake = fakeBridge()
    const opened = await openChat(PROJECT, { bridge: fake.bridge, admit: async () => ({ ok: true }) })
    if (!opened.ok) throw new Error("non aperta")
    await expect(opened.client.session.list({ directory: "D:/altro" })).rejects.toThrow("D:/altro")
    await expect(opened.client.session.list({ directory: "c:\\PROGETTO\\" })).resolves.toBeDefined()
    expect(fake.sent).toHaveLength(1)
    for (const request of fake.sent) expect(request.path).not.toContain("altro")
  })

  /* C2 review, BASSO: a plugin added to `.nikcli/` during the conversation. */
  test("the trust is checked again before every request; after a no nothing leaves and nothing is asked again", async () => {
    const fake = fakeBridge()
    let trusted = true
    let asked = 0
    const opened = await openChat(PROJECT, {
      bridge: fake.bridge,
      admit: async () => {
        asked++
        return trusted ? { ok: true } : { ok: false, problem: "Il progetto è cambiato e non ti fidi più." }
      },
    })
    if (!opened.ok) throw new Error("non aperta")
    await opened.client.session.list({ roots: true })
    expect(asked).toBe(2)
    expect(fake.sent).toHaveLength(1)

    trusted = false
    const refusal = (error: unknown) => isChatRefused(error) && String(error).includes("Il progetto è cambiato e non ti fidi più.")
    expect(await opened.client.session.list({ roots: true }).then(() => undefined, refusal)).toBe(true)
    // Trusted again meanwhile, it stays closed: the store opens a new chat, nothing retries into a dialog.
    trusted = true
    expect(await opened.client.session.list({ roots: true }).then(() => undefined, refusal)).toBe(true)
    expect(asked).toBe(3)
    expect(fake.sent).toHaveLength(1)
  })
})
