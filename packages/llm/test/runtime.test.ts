import { describe, expect, test } from "bun:test"
import { LLM } from "../src"
import * as OpenAIChat from "../src/protocols/openai-chat"
import { streamRequest } from "../src/runtime"
import { deltaChunk, finishChunk } from "./lib/openai-chunks"
import { sseEvents } from "./lib/sse"

const body = sseEvents(deltaChunk({ role: "assistant", content: "hi" }), finishChunk("stop"))

const request = (apiKey: string | undefined) =>
  LLM.request({
    model: OpenAIChat.model({ id: "gpt-4o-mini", baseURL: "https://api.openai.test/v1", apiKey }),
    prompt: "hello",
  })

const collect = async (events: AsyncIterable<{ type: string }>) => {
  const out: string[] = []
  for await (const event of events) out.push(event.type)
  return out
}

describe("runtime.streamRequest fetch override", () => {
  test("sends the request through the supplied fetch", async () => {
    const seen: Array<{ url: string; authorization: string | null }> = []
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      })
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    }) as typeof globalThis.fetch

    const events = await collect(streamRequest(request("static-key"), { fetch }))

    expect(events).toContain("text-delta")
    expect(events.at(-1)).toBe("request-finish")
    expect(seen).toEqual([{ url: "https://api.openai.test/v1/chat/completions", authorization: "Bearer static-key" }])
  })

  test("lets the fetch own auth and the endpoint (OAuth-style rewrite)", async () => {
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.openai.test/v1/chat/completions")
      const headers = new Headers(init?.headers)
      headers.set("authorization", "Bearer renewed-token")
      expect(headers.get("authorization")).toBe("Bearer renewed-token")
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    }) as typeof globalThis.fetch

    // The placeholder key a provider with an OAuth session carries; the fetch replaces it per request.
    expect(await collect(streamRequest(request("oauth-placeholder"), { fetch }))).toContain("text-delta")
  })

  test("surfaces a fetch failure as a stream error", async () => {
    const fetch = (async () => {
      throw new Error("offline")
    }) as unknown as typeof globalThis.fetch

    await expect(collect(streamRequest(request("k"), { fetch }))).rejects.toBeDefined()
  })
})
