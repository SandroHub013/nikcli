import { describe, expect, test } from "bun:test"
import { DENIED, isLocalAddress } from "./consent"

describe("which addresses a panel opens without asking (review-alti, 1.3)", () => {
  test("this machine's own: localhost, 127.0.0.1 and ::1, on any port and path", () => {
    for (const url of ["http://localhost:3000/x", "http://LOCALHOST:5173", "https://127.0.0.1:8443/", "http://[::1]:4000/a"]) {
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

  test("a refusal says the user said no", () => {
    expect(DENIED).toBe("negato dall'utente")
  })
})
