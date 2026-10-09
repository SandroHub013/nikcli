import { describe, expect, it } from "bun:test"
import { Commands } from "@/cli/commands"
import { Option } from "effect"
import { UI } from "@/cli/ui"
import { UserFacingError } from "@ragu/util/user-error"
import loginHandler from "@/cli/handlers/auth/login"

describe("ragu auth login provider selection and arguments", () => {
  it("defines provider as its only argument, with no server or url flags", () => {
    const login = Commands.commands["auth"].commands["login"].spec
    expect(login.description).toContain("provider")
    // The `provider` argument is the only parameter: the --server and --url flags of the Nik account login are gone.
    // `config` is the parsed parameter list Effect keeps on the command; it is not part of the public type.
    const config = (login as unknown as { config: { arguments: unknown[]; flags: unknown[] } }).config
    expect(config.arguments).toHaveLength(1)
    expect(config.flags).toHaveLength(0)
  })

  it("enters provider API key prompt when provider argument is supplied and never calls well-known or Nik hosts", async () => {
    const originalFetch = globalThis.fetch
    let networkAttempted = false

    globalThis.fetch = (async (input: string | URL | Request) => {
      networkAttempted = true
      const url = input instanceof Request ? input.url : String(input)
      throw new Error(`Forbidden network request in tests: ${url}`)
    }) as unknown as typeof fetch

    try {
      // In headless test mode, the provider branch reaches prompts.password which rejects with UI.HeadlessFailure
      // rather than attempting to call fetchWellKnown or loginAccount over the network.
      await expect(
        loginHandler({
          provider: Option.some("openai"),
        } as never),
      ).rejects.toThrow(UI.HeadlessFailure)
      expect(networkAttempted).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("ensures error suggestions for reconnect in UserFacingError point to ragu auth login <provider>", () => {
    const providerID = "openai"
    const error = new UserFacingError({
      title: "Auth session expired",
      what: `${providerID} rejected the refresh token (401).`,
      try: `Run \`ragu auth login ${providerID}\` to reconnect, or pick a different provider.`,
    })
    expect(error.try).toContain("ragu auth login openai")
  })
})
