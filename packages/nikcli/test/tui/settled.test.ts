import { describe, expect, it } from "bun:test"
import { ClientError } from "@nikcli-ai/sdk/httpapi"
import { clientErrorStatus, isTransientHttpInterrupt, namedFailures, retryTransient } from "@tui/util/settled"

const ok = (value: unknown): PromiseSettledResult<unknown> => ({ status: "fulfilled", value })
const bad = (reason: unknown): PromiseSettledResult<unknown> => ({ status: "rejected", reason })

describe("namedFailures", () => {
  it("reports nothing when everything settled fulfilled", () => {
    expect(namedFailures(["a", "b"], [ok(1), ok(2)])).toEqual({ failed: [], errors: [] })
  })

  it("names only the rejected entries, keeping their order", () => {
    const result = namedFailures(["a", "b", "c"], [bad(new Error("x")), ok(1), bad(new Error("y"))])
    expect(result.failed).toEqual(["a", "c"])
    expect(result.errors).toEqual(["x", "y"])
  })

  it("keeps the successes — the thing Promise.all discards", () => {
    // With `Promise.all` the first rejection hides that b and c succeeded.
    const result = namedFailures(["a", "b", "c"], [bad(new Error("boom")), ok(1), ok(2)])
    expect(result.failed).toEqual(["a"])
    expect(result.failed).not.toContain("b")
    expect(result.failed).not.toContain("c")
  })

  it("stringifies a non-Error rejection", () => {
    expect(namedFailures(["a"], [bad("plain string")]).errors).toEqual(["plain string"])
    expect(namedFailures(["a"], [bad(undefined)]).errors).toEqual(["undefined"])
  })

  it("aligns errors with failed names", () => {
    const result = namedFailures(["first", "second"], [bad(new Error("one")), bad(new Error("two"))])
    expect(result.failed.length).toBe(result.errors.length)
    expect(result.failed.indexOf("second")).toBe(result.errors.indexOf("two"))
  })

  it("refuses a mismatched batch rather than misattributing a failure", () => {
    // Silently zipping the shorter list would blame the wrong endpoint.
    expect(() => namedFailures(["a", "b"], [ok(1)])).toThrow(RangeError)
  })

  it("handles an empty batch", () => {
    expect(namedFailures([], [])).toEqual({ failed: [], errors: [] })
  })
})

function statusError(status: number) {
  return new ClientError("UnexpectedStatus", { cause: { status } })
}

describe("clientErrorStatus", () => {
  it("reads the generated-client status cause", () => {
    expect(clientErrorStatus(statusError(499))).toBe(499)
    expect(clientErrorStatus(new Error("plain"))).toBeUndefined()
  })
})

describe("isTransientHttpInterrupt", () => {
  it("treats Effect abort statuses as retryable", () => {
    expect(isTransientHttpInterrupt(statusError(499))).toBe(true)
    expect(isTransientHttpInterrupt(statusError(503))).toBe(true)
    expect(isTransientHttpInterrupt(statusError(500))).toBe(false)
    expect(isTransientHttpInterrupt(new Error("boom"))).toBe(false)
  })
})

describe("retryTransient", () => {
  it("returns the first success", async () => {
    expect(await retryTransient(async () => 7, { retries: 2, delayMs: 1 })).toBe(7)
  })

  it("retries a 499 and then succeeds", async () => {
    let attempts = 0
    const value = await retryTransient(
      async () => {
        attempts++
        if (attempts < 3) throw statusError(499)
        return "ok"
      },
      { retries: 2, delayMs: 1 },
    )
    expect(value).toBe("ok")
    expect(attempts).toBe(3)
  })

  it("does not retry a non-transient failure", async () => {
    let attempts = 0
    await expect(
      retryTransient(
        async () => {
          attempts++
          throw statusError(400)
        },
        { retries: 2, delayMs: 1 },
      ),
    ).rejects.toMatchObject({ reason: "UnexpectedStatus" })
    expect(attempts).toBe(1)
  })
})
