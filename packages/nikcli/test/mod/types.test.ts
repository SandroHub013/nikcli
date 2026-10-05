import { describe, expect, it } from "bun:test"
import type { ModRegister } from "@nikcli-ai/plugin/mod"

/**
 * Compile-time contract for mod authors: `tsc` is the assertion. The `@ts-expect-error`
 * lines fail the typecheck if the types ever stop rejecting a wrong hook.
 */
const register: ModRegister = (on) => {
  on("tool.call", { tool: "bash" }, async ($, e, next) => {
    const command: unknown = e.command
    if (typeof command === "string" && /git push .*--force/.test(command)) return { deny: "no" }
    return next({ ...e, command: "echo ok" })
  }).catch(async ($, e, next) => ({ deny: `guard failed: ${next.error?.kind}` }))

  on("tool.check", async ($, e, next) => {
    const decided = await next(e)
    return e.rule === "deny" ? { decision: "deny", reason: "rule" } : decided
  })

  on("prompt.submit", async ($, e, next) => next({ ...e, text: e.text.trim(), context: [...e.context, "x"] }))

  // @ts-expect-error a tool.check hook must answer allow, ask or deny
  on("tool.check", async () => ({ decision: "maybe" }))

  // @ts-expect-error session.start has no `text`
  on("session.start", { text: "x" }, async ($, e, next) => next(e))

  on("fs.read", async ($, e, next) => next(e))
}

describe("mod author types", () => {
  it("compile", () => {
    expect(typeof register).toBe("function")
  })
})
