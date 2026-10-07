import { afterEach, describe, expect, it } from "bun:test"
import { Runtime } from "@nikcli-ai/llm"
import { AnthropicMessages, OpenAIResponses } from "@nikcli-ai/llm/protocols"
import type { ModelMessage } from "@/session/llm/types"
import { LLM } from "@/session/llm"

/**
 * `NIKCLI_CACHE_RETENTION=long` has to reach the wire. The native route builds its own breakpoints from `LLMRequest.cache`, so the
 * setting is only worth what the body says: these tests build the request the way a turn does and read `cache_control` off the body
 * `prepareRequest` produces, which is what the provider receives.
 */

const anthropic = AnthropicMessages.model({
  id: "claude-sonnet-4-5",
  baseURL: "https://api.anthropic.test/v1/",
  headers: { "x-api-key": "test" },
})
const openai = OpenAIResponses.model({
  id: "gpt-5.6",
  baseURL: "https://api.openai.test/v1/",
  headers: { authorization: "Bearer test" },
})

const user = (text: string): ModelMessage => ({ role: "user", content: [{ type: "text", text }] })
const assistant = (text: string): ModelMessage => ({ role: "assistant", content: [{ type: "text", text }] })
const turn = (model: typeof anthropic) =>
  LLM.buildLLMRequest(
    {
      system: ["You are the agent.", "Project instructions."],
      messages: [user("first"), assistant("second"), user("third")],
      tools: {},
    },
    model,
    { maxOutputTokens: 100 },
  )

/** Every `cache_control` a body really carries, in the order they appear (an unmarked block has the key with `undefined`, which JSON drops). */
function controls(value: unknown, found: unknown[] = []): unknown[] {
  if (Array.isArray(value)) for (const item of value) controls(item, found)
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "cache_control") {
        if (item !== undefined) found.push(item)
      }
      else controls(item, found)
    }
  }
  return found
}

const before = process.env["NIKCLI_CACHE_RETENTION"]
afterEach(() => {
  if (before === undefined) delete process.env["NIKCLI_CACHE_RETENTION"]
  else process.env["NIKCLI_CACHE_RETENTION"] = before
})

describe("NIKCLI_CACHE_RETENTION on the native route", () => {
  it("long puts the one-hour entry on every breakpoint of the Anthropic body", async () => {
    process.env["NIKCLI_CACHE_RETENTION"] = "long"
    const prepared = await Runtime.prepareRequest(turn(anthropic))
    const marks = controls(prepared.body)
    // First and last system part and the trailing two messages: four breakpoints, the most Anthropic accepts.
    expect(marks).toHaveLength(4)
    for (const mark of marks) expect(mark).toEqual({ type: "ephemeral", ttl: "1h" })
  })

  it("by default the body carries the 5-minute entry and no ttl at all", async () => {
    delete process.env["NIKCLI_CACHE_RETENTION"]
    const prepared = await Runtime.prepareRequest(turn(anthropic))
    const marks = controls(prepared.body)
    expect(marks).toHaveLength(4)
    for (const mark of marks) expect(mark).toEqual({ type: "ephemeral" })
    expect(JSON.stringify(prepared.body)).not.toContain("ttl")
    process.env["NIKCLI_CACHE_RETENTION"] = "short"
    expect(JSON.stringify((await Runtime.prepareRequest(turn(anthropic))).body)).not.toContain("ttl")
  })

  it("long changes nothing but the ttl: same breakpoints in the same places", async () => {
    delete process.env["NIKCLI_CACHE_RETENTION"]
    const short = await Runtime.prepareRequest(turn(anthropic))
    process.env["NIKCLI_CACHE_RETENTION"] = "long"
    const long = await Runtime.prepareRequest(turn(anthropic))
    expect(JSON.parse(JSON.stringify(long.body).replaceAll(',"ttl":"1h"', ""))).toEqual(short.body)
  })

  it("is not sent to a route that has no ttl to carry it", async () => {
    process.env["NIKCLI_CACHE_RETENTION"] = "long"
    expect(turn(openai).cache).toBeUndefined()
    const prepared = await Runtime.prepareRequest(turn(openai))
    expect(JSON.stringify(prepared.body)).not.toContain("ttl")
  })
})
