import { describe, expect, it } from "bun:test"
import { footerModel, footerProvider, sessionRequestContext } from "@tui/component/prompt"

describe("prompt session request context", () => {
  it("builds prompt and command context for an attached session", () => {
    const context = sessionRequestContext({
      routeWorkspaceID: "wrk_route",
      sessionWorkspaceID: "wrk_session",
      fallbackWorkspaceID: "wrk_fallback",
      sessionDirectory: "/worktrees/feature",
      fallbackDirectory: "/repo",
    })
    expect(context).toEqual({ workspace: "wrk_route", directory: "/worktrees/feature" })
  })

  it("omits workspace for detached prompt and command payloads", () => {
    const context = sessionRequestContext({
      fallbackDirectory: "/repo",
      sessionDirectory: "/repo",
    })
    expect(context).toEqual({ workspace: undefined, directory: "/repo" })
  })
})

describe("prompt footer names", () => {
  it("drops the vendor prefix the provider name already shows", () => {
    expect(footerModel("MiniMax-M3.1-Flash-Preview", "MiniMax Token Plan (minimax.io)")).toBe("M3.1-Flash-Preview")
    // Nothing would be left: the name stays.
    expect(footerModel("MiniMax", "MiniMax")).toBe("MiniMax")
    // A different vendor is not a prefix to drop.
    expect(footerModel("GPT-Reserve", "OpenAI")).toBe("GPT-Reserve")
  })

  it("drops a trailing release date", () => {
    expect(footerModel("claude-opus-4-5-20251101", "Anthropic")).toBe("claude-opus-4-5")
    expect(footerModel("gemini-2.5-pro-2025-06-17", "Google")).toBe("gemini-2.5-pro")
  })

  it("cuts a long name in the middle, keeping the suffix that tells models apart", () => {
    const short = footerModel("Qwen3 Coder 480B A35B Instruct Turbo", "Together AI")
    expect(short.length).toBeLessThanOrEqual(22)
    expect(short.startsWith("Qwen3")).toBe(true)
    expect(short.endsWith("Turbo")).toBe(true)
    expect(short).toContain("…")
  })

  it("drops the provider's parenthetical qualifier and caps its length", () => {
    expect(footerProvider("MiniMax Token Plan (minimax.io)")).toBe("MiniMax Token Plan")
    expect(footerProvider("OpenAI")).toBe("OpenAI")
    const long = footerProvider("Some Very Long Provider Name Inc")
    expect(long.length).toBeLessThanOrEqual(18)
    expect(long.endsWith("…")).toBe(true)
  })
})
