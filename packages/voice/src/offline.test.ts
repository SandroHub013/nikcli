import { describe, expect, test } from "bun:test"
import { openRouterCreditLeft } from "./asr/openrouter"
import { offlineGuard } from "./offline-guard"

describe("the suite does not go to the network", () => {
  test("the guard is the one the preload armed, not a second one this import made", () => {
    expect(globalThis.__offlineGuard).toBe(offlineGuard)
  })

  test("a remote request is refused here, before it leaves", async () => {
    await expect(globalThis.fetch("https://openrouter.ai/api/v1/credits")).rejects.toThrow(/non deve andare in rete/)
    offlineGuard.ignoreLast()
  })

  test("a credit check with the default fetch sends nothing and learns nothing", async () => {
    expect(await openRouterCreditLeft("sk-or-test")).toBeUndefined()
    offlineGuard.ignoreLast()
  })

  test("no test of this run has asked the network anything", () => {
    expect(offlineGuard.attempts).toEqual([])
  })
})
