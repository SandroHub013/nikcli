import { describe, expect, test } from "bun:test"
import { admitProject, surfaceFingerprint } from "../bots/project-trust"
import { memoryTrustStore } from "../bots/trust"
import { FRESH_MS, isChatRefused, openChat } from "./connection"
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
      return { url: "http://127.0.0.1:49374", version: "1.389.0" }
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
    let clock = 0
    const opened = await openChat(PROJECT, {
      bridge: fake.bridge,
      now: () => clock,
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
    clock += FRESH_MS
    const refusal = (error: unknown) => isChatRefused(error) && String(error).includes("Il progetto è cambiato e non ti fidi più.")
    expect(await opened.client.session.list({ roots: true }).then(() => undefined, refusal)).toBe(true)
    // Trusted again meanwhile, it stays closed: the store opens a new chat, nothing retries into a dialog.
    trusted = true
    expect(await opened.client.session.list({ roots: true }).then(() => undefined, refusal)).toBe(true)
    expect(asked).toBe(3)
    expect(fake.sent).toHaveLength(1)
  })

  /* C2 review, M2: a request arriving while the dialog is open is no refusal. */
  test("a changed project and two requests at once: one dialog, and after the yes both leave", async () => {
    const fake = fakeBridge()
    const store = memoryTrustStore()
    const files = [{ path: ".nikcli/nikcli.json", text: "{}" }]
    store.set(PROJECT, await surfaceFingerprint(files))
    let surface = files
    const dialogs: string[] = []
    let answer: (yes: boolean) => void = () => {}
    let clock = 0
    const opened = await openChat(PROJECT, {
      bridge: fake.bridge,
      now: () => clock,
      admit: (directory) =>
        admitProject(directory, {
          store,
          surface: async () => surface,
          confirm: (question) => {
            dialogs.push(question)
            return new Promise<boolean>((resolve) => (answer = resolve))
          },
        }),
    })
    if (!opened.ok) throw new Error("non aperta")
    // A git pull adds a plugin to .nikcli/.
    surface = [...files, { path: ".nikcli/plugin/nuovo.ts", text: "export default {}" }]
    clock += FRESH_MS
    const first = opened.client.session.list({ roots: true })
    const second = opened.client.session.status()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(dialogs).toHaveLength(1)
    expect(fake.sent).toHaveLength(0)
    answer(true)
    await first
    await second
    expect(fake.sent).toHaveLength(2)
    expect(dialogs).toHaveLength(1)
  })

  /* C2 review, BASSO: a bootstrap's burst reads the project's files once. */
  test("requests close together check the trust once; later ones check again", async () => {
    const fake = fakeBridge()
    let asked = 0
    let clock = 0
    const opened = await openChat(PROJECT, {
      bridge: fake.bridge,
      now: () => clock,
      admit: async () => {
        asked++
        return { ok: true }
      },
    })
    if (!opened.ok) throw new Error("non aperta")
    await Promise.all([opened.client.session.list({ roots: true }), opened.client.session.status(), opened.client.session.list({})])
    expect(asked).toBe(2)
    clock += FRESH_MS - 1
    await opened.client.session.status()
    expect(asked).toBe(2)
    clock += 1
    await opened.client.session.status()
    expect(asked).toBe(3)
    expect(fake.sent).toHaveLength(5)
  })

  test("an answer without a reason is no refusal: that request fails, the next one can pass", async () => {
    const fake = fakeBridge()
    let pending = true
    let clock = 0
    const opened = await openChat(PROJECT, {
      bridge: fake.bridge,
      now: () => clock,
      admit: async () => (pending ? { ok: false } : { ok: true }),
    }).catch(() => undefined)
    // Opening itself needs a yes: with a bare no it does not open.
    expect(opened).toEqual({ ok: false })
    pending = false
    const again = await openChat(PROJECT, { bridge: fake.bridge, now: () => clock, admit: async () => (pending ? { ok: false } : { ok: true }) })
    if (!again.ok) throw new Error("non aperta")
    pending = true
    const failed = await again.client.session.status().then(() => undefined, (error: unknown) => error)
    expect(failed).toBeDefined()
    expect(isChatRefused(failed)).toBe(false)
    pending = false
    await again.client.session.status()
    expect(fake.sent).toHaveLength(1)
  })
})
