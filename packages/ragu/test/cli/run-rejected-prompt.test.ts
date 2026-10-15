import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { executeTurn, rejectionMessage } from "@/cli/handlers/run"
import type { RaguClient } from "@ragu/sdk/httpapi"

/*
 * Review of the CLI, P0 5: `ragu run` threw away the answer of `session.prompt`. A request the server turned down (an
 * unknown `-s` session) starts no turn, so the `session.idle` it waited for never came and the command never ended.
 * No model is called: the client is a stand-in whose event stream stays silent until it is told to stop.
 */
type Reply = { data: unknown; error: unknown }

function fakeClient(reply: Reply, events: unknown[] = []) {
  const calls = { subscribed: 0, aborted: false }
  const sdk = {
    event: {
      subscribe: async (_input?: unknown, options?: { signal?: AbortSignal }) => {
        calls.subscribed++
        options?.signal?.addEventListener("abort", () => (calls.aborted = true))
        return {
          stream: (async function* () {
            for (const event of events) yield event
            // Nothing more is coming, like a server that started no turn: only an abort ends this.
            await new Promise((_, reject) =>
              options?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
            )
          })(),
        }
      },
    },
    session: { prompt: async () => reply, command: async () => reply },
  }
  return { sdk: sdk as unknown as RaguClient, calls }
}

const turn = (sdk: RaguClient) =>
  executeTurn({ sdk, sessionID: "ses_gone", message: "hi", format: "default", exitOnError: false })

describe("ragu run when the server refuses the prompt", () => {
  test("it ends with the server's message instead of waiting for a session.idle that never comes", async () => {
    const { sdk, calls } = fakeClient({
      data: undefined,
      error: { name: "NotFoundError", data: { message: "Session not found: ses_gone" } },
    })
    const result = await Promise.race([turn(sdk), Bun.sleep(5_000).then(() => "hung" as const)])
    expect(result).toEqual({ error: "NotFoundError: Session not found: ses_gone" })
    expect(calls.aborted).toBe(true)
  })

  test("the same for a command", async () => {
    const { sdk } = fakeClient({ data: undefined, error: new Error("input refused") })
    const result = await Promise.race([
      executeTurn({ sdk, sessionID: "ses_gone", message: "x", command: "init", format: "default", exitOnError: false }),
      Bun.sleep(5_000).then(() => "hung" as const),
    ])
    expect(result).toEqual({ error: "input refused" })
  })

  test("an accepted prompt is still a turn that ends with its session.idle", async () => {
    const { sdk, calls } = fakeClient({ data: {}, error: undefined }, [
      { type: "session.idle", properties: { sessionID: "ses_gone" } },
    ])
    expect(await turn(sdk)).toEqual({})
    expect(calls.aborted).toBe(false)
  })

  test("the process exits non-zero on a refusal unless the caller asked to keep going", () => {
    const text = readFileSync(join(import.meta.dir, "../../src/cli/handlers/run.ts"), "utf8")
    expect(text).toMatch(/if \(rejected !== undefined\) \{[\s\S]*?if \(input\.exitOnError !== false\) process\.exit\(1\)/)
  })
})

describe("rejectionMessage", () => {
  test("a server error says its name and its message", () => {
    expect(rejectionMessage({ name: "BadRequest", data: { message: "bad part" } })).toBe("BadRequest: bad part")
    expect(rejectionMessage({ message: "plain" })).toBe("plain")
  })

  test("an Error says its message, anything else is shown as it is", () => {
    expect(rejectionMessage(new Error("boom"))).toBe("boom")
    expect(rejectionMessage("text")).toBe("text")
    expect(rejectionMessage({ code: 7 })).toBe('{"code":7}')
  })
})
