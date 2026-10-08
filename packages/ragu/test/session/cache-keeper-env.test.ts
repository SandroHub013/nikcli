import { afterEach, describe, expect, it } from "bun:test"
import { Flag } from "@ragu/util/flag"
import { CacheKeeper } from "@/session/cache-keeper"

/** The keeper's numbers from the environment: `0` is a budget for MAX_RENEWALS and «not set» everywhere else. */

const NAMES = [
  "RAGU_CACHE_KEEPALIVE_MAX_RENEWALS",
  "RAGU_CACHE_KEEPALIVE_LIFETIME_S",
  "RAGU_CACHE_KEEPALIVE_MARGIN_PCT",
  "RAGU_CACHE_KEEPALIVE_MIN_TOKENS",
  "RAGU_CACHE_KEEPALIVE_HORIZON_S",
]

afterEach(() => {
  for (const name of NAMES) delete process.env[name]
})

describe("Flag.cacheKeepaliveNumber", () => {
  it("0 is a value only where it is asked for", () => {
    process.env["RAGU_CACHE_KEEPALIVE_MAX_RENEWALS"] = "0"
    expect(Flag.cacheKeepaliveNumber("RAGU_CACHE_KEEPALIVE_MAX_RENEWALS", { allowZero: true })).toBe(0)
    expect(Flag.cacheKeepaliveNumber("RAGU_CACHE_KEEPALIVE_MAX_RENEWALS")).toBeUndefined()
    process.env["RAGU_CACHE_KEEPALIVE_HORIZON_S"] = "0"
    expect(Flag.cacheKeepaliveNumber("RAGU_CACHE_KEEPALIVE_HORIZON_S")).toBeUndefined()
  })

  it("negatives, NaN, text and empty stay «not set», even where 0 is allowed", () => {
    for (const raw of ["-1", "abc", "NaN", "Infinity", "", "  "]) {
      process.env["RAGU_CACHE_KEEPALIVE_MAX_RENEWALS"] = raw
      expect(Flag.cacheKeepaliveNumber("RAGU_CACHE_KEEPALIVE_MAX_RENEWALS", { allowZero: true })).toBeUndefined()
      expect(Flag.cacheKeepaliveNumber("RAGU_CACHE_KEEPALIVE_MAX_RENEWALS")).toBeUndefined()
    }
  })

  it("positive numbers read as before", () => {
    process.env["RAGU_CACHE_KEEPALIVE_MAX_RENEWALS"] = "3"
    expect(Flag.cacheKeepaliveNumber("RAGU_CACHE_KEEPALIVE_MAX_RENEWALS", { allowZero: true })).toBe(3)
    expect(Flag.cacheKeepaliveNumber("RAGU_CACHE_KEEPALIVE_MAX_RENEWALS")).toBe(3)
  })
})

describe("CacheKeeper.settings", () => {
  it("MAX_RENEWALS=0 is a budget of 0, not the break-even of the provider", () => {
    process.env["RAGU_CACHE_KEEPALIVE_MAX_RENEWALS"] = "0"
    expect(CacheKeeper.settings().maxRenewals).toBe(0)
  })

  it("the other numbers keep 0 as «not set» (their defaults apply)", () => {
    process.env["RAGU_CACHE_KEEPALIVE_MIN_TOKENS"] = "0"
    process.env["RAGU_CACHE_KEEPALIVE_MARGIN_PCT"] = "0"
    process.env["RAGU_CACHE_KEEPALIVE_LIFETIME_S"] = "0"
    process.env["RAGU_CACHE_KEEPALIVE_HORIZON_S"] = "0"
    expect(CacheKeeper.settings()).toMatchObject({
      minTokens: 20_000,
      marginPct: 10,
      lifetimeS: undefined,
      horizonS: undefined,
      maxRenewals: undefined,
    })
  })
})

describe("the three-state switches", () => {
  const SWITCHES = ["RAGU_CACHE_KEEPALIVE", "RAGU_CACHE_KEEPALIVE_COMPACT", "RAGU_COMPACTION_SHARED_PREFIX"]
  afterEach(() => {
    for (const name of SWITCHES) delete process.env[name]
  })

  it("on, off and not said", () => {
    const read = (value: string | undefined) => {
      if (value === undefined) delete process.env["RAGU_CACHE_KEEPALIVE"]
      else process.env["RAGU_CACHE_KEEPALIVE"] = value
      return Flag.cacheKeepaliveSetting()
    }
    expect(read("1")).toBe(true)
    expect(read("true")).toBe(true)
    expect(read("0")).toBe(false)
    expect(read("False")).toBe(false)
    expect(read(undefined)).toBeUndefined()
    expect(read("")).toBeUndefined()
    expect(read("maybe")).toBeUndefined()
  })

  it("the other two read the same way", () => {
    process.env["RAGU_CACHE_KEEPALIVE_COMPACT"] = "0"
    process.env["RAGU_COMPACTION_SHARED_PREFIX"] = "1"
    expect(Flag.cacheKeepaliveCompactSetting()).toBe(false)
    expect(Flag.compactionSharedPrefixSetting()).toBe(true)
  })
})
