import { describe, expect, it } from "bun:test"
import { normalizeServerUrl } from "@/account/url"
import { Commands } from "@/cli/commands"
import { Account } from "@/account"
import { runPromiseWithLayer } from "@/effect"
import { Effect } from "effect"
import { tuiSource } from "../tui/tui-source"

describe("removal of Nik account and device-code login", () => {
  it("never defaults to auth.nikcli-ai.dev in normalizeServerUrl", () => {
    expect(normalizeServerUrl("")).toBe("")
    expect(normalizeServerUrl("   ")).toBe("")
  })

  it("does not register the account CLI command group", () => {
    expect((Commands.commands as Record<string, unknown>)["account"]).toBeUndefined()
  })

  it("fails if any network request attempts to call auth.nikcli-ai.dev on login", async () => {
    const originalFetch = globalThis.fetch
    let nikHostCalled = false

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes("nikcli-ai.dev") || url.includes("nikcli.store")) {
        nikHostCalled = true
      }
      throw new Error(`Forbidden network request in tests: ${url}`)
    }) as unknown as typeof fetch

    try {
      await expect(
        runPromiseWithLayer(
          Account.defaultLayer,
          Effect.gen(function* () {
            const account = yield* Account.Service
            return yield* account.login()
          }),
        ),
      ).rejects.toThrow(/Remote Nik account service has been removed/)
      expect(nikHostCalled).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("rejects token refresh towards nikcli-ai.dev without network calls", async () => {
    const originalFetch = globalThis.fetch
    let fetchCalled = false

    globalThis.fetch = (async (input: string | URL | Request) => {
      fetchCalled = true
      const url = input instanceof Request ? input.url : String(input)
      throw new Error(`Unexpected network call: ${url}`)
    }) as unknown as typeof fetch

    try {
      await expect(
        runPromiseWithLayer(
          Account.defaultLayer,
          Effect.gen(function* () {
            const account = yield* Account.Service
            return yield* account.poll("dummy-code" as never, { serverUrl: "https://auth.nikcli-ai.dev" })
          }),
        ),
      ).rejects.toThrow(/Remote Nik account service has been removed/)
      expect(fetchCalled).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("ensures TUI onboarding has removed the Nik account login step", async () => {
    const onboardingSource = await tuiSource("component/dialog-onboarding.tsx")
    expect(onboardingSource).not.toContain("STEP.ACCOUNT")
    expect(onboardingSource).not.toContain("DialogAccountLogin")
    expect(onboardingSource).not.toContain("auth.nikcli-ai.dev")
  })

  it("ensures TUI startup does not prompt for account login", async () => {
    const appSource = await tuiSource("app.tsx")
    expect(appSource).not.toContain("DialogAccountLogin")
    expect(appSource).not.toMatch(/DialogLogin\.run\(dialog,\s*sdk\)/)
  })
})
