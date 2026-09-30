import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { sha256Hex } from "./hash"

describe("sha256Hex", () => {
  test("the published vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    )
  })

  test("it agrees with node's on lengths around the block edges, and on UTF-8", () => {
    for (const length of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 4097]) {
      const text = "x".repeat(length)
      expect([length, sha256Hex(text)]).toEqual([length, createHash("sha256").update(text).digest("hex")])
    }
    for (const text of ["è", "città", "日本語", "🙂", "C:\\work\\nikcli", "salt\nr:c:/work/nikcli"]) {
      expect([text, sha256Hex(text)]).toEqual([text, createHash("sha256").update(text).digest("hex")])
    }
  })
})
