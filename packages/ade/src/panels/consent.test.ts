import { describe, expect, test } from "bun:test"
import { DENIED, isLocalAddress } from "./consent"

describe("which addresses a panel opens without asking (review-alti, 1.3)", () => {
  test("this machine's own: localhost, 127.0.0.1 and ::1, on any port and path", () => {
    for (const url of [
      "http://localhost:3000/x",
      "http://LOCALHOST:5173",
      "https://127.0.0.1:8443/",
      "http://[::1]:4000/a",
    ]) {
      expect(isLocalAddress(url)).toBe(true)
    }
  })

  test("anything else asks: other hosts, names that only look local, other loopback spellings, garbage", () => {
    for (const url of [
      "https://example.com",
      "http://localhost.evil.example",
      "http://evil.example/localhost",
      "http://127.0.0.2:3000",
      "http://0.0.0.0:3000",
      "http://192.168.1.10:3000",
      "file:///C:/Windows",
      "non un url",
    ]) {
      expect(isLocalAddress(url)).toBe(false)
    }
  })

  /*
   * The cases a change of parser would get wrong without showing (review-alti-seguito,
   * BASSO 1): a name that only looks local, a loopback written another way, a
   * userinfo that hides the real host behind a local-looking one. Each also
   * asserts the `hostname` the parser produced, so a parser that stops
   * normalising says so here, instead of quietly flipping a verdict.
   */
  test("userinfo: the host is what follows the @, never what precedes it", () => {
    expect(new URL("http://localhost@evil.com").hostname).toBe("evil.com")
    expect(isLocalAddress("http://localhost@evil.com")).toBe(false)
    expect(new URL("http://evil.com@localhost").hostname).toBe("localhost")
    expect(isLocalAddress("http://evil.com@localhost")).toBe(true)
    expect(isLocalAddress("http://evil.com@localhost:3000/x")).toBe(true)
  })

  test("a loopback written another way is the same loopback", () => {
    for (const url of [
      "http://127.1",
      "http://127.1:3000/x",
      "http://2130706433",
      "http://2130706433:3000",
      "http://0x7f.1",
    ]) {
      expect([url, new URL(url).hostname]).toEqual([url, "127.0.0.1"])
      expect([url, isLocalAddress(url)]).toEqual([url, true])
    }
  })

  test("a loopback written in v4 form asks, and the long form of ::1 is the one recognised", () => {
    // The parser leaves this one as `[::ffff:7f00:1]`, which is not in the set: one
    // loopback too many, on the safe side.
    expect(new URL("http://[::ffff:127.0.0.1]").hostname).toBe("[::ffff:7f00:1]")
    expect(isLocalAddress("http://[::ffff:127.0.0.1]")).toBe(false)
    expect(isLocalAddress("http://[::ffff:127.0.0.1]:3000")).toBe(false)
    // The same address written out is the one that is recognised.
    expect(new URL("http://[0:0:0:0:0:0:0:1]").hostname).toBe("[::1]")
    expect(isLocalAddress("http://[0:0:0:0:0:0:0:1]")).toBe(true)
  })

  test("a name that only looks local asks, the trailing dot included", () => {
    // The parser keeps the dot, so `localhost.` is not `localhost`.
    expect(new URL("http://localhost.").hostname).toBe("localhost.")
    for (const url of [
      "http://localhost.",
      "http://localhost.:3000/x",
      "http://LOCALHOST.",
      "http://127.0.0.1.nip.io",
      "http://127.0.0.1.nip.io:3000",
    ]) {
      expect([url, isLocalAddress(url)]).toEqual([url, false])
    }
  })

  test("0.0.0.0 is not this machine's own address, so it asks", () => {
    expect(new URL("http://0.0.0.0").hostname).toBe("0.0.0.0")
    expect(isLocalAddress("http://0.0.0.0")).toBe(false)
    expect(isLocalAddress("http://0.0.0.0:3000")).toBe(false)
  })

  test("a refusal says the user said no", () => {
    expect(DENIED).toBe("negato dall'utente")
  })
})
