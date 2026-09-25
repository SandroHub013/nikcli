import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"

/*
 * The recorded fixtures go into the repository as they are: nothing of the
 * machine or the account that recorded them may be left in. Every file in
 * `fixtures/` is read, the ones added later too.
 */

const DIR = new URL("./fixtures/", import.meta.url)

/** Paths the recordings are rewritten to; any other absolute path is the recorder's. */
const ALLOWED_PATH = /^[A-Za-z]:(\\\\|\\|\/)+(progetto|Users(\\\\|\\|\/)+utente)\b/

const FORBIDDEN: [string, RegExp][] = [
  // The provider's refusals name the account that made the call.
  ["an account id", /user_(?!anonimo\b)[A-Za-z0-9]{8,}/],
  ["a key", /\bsk-[A-Za-z0-9_-]{8,}/],
  ["a bearer token", /Bearer\s/i],
  ["an authorization header", /authorization/i],
  ["a unix home", /\/(home|Users)\/(?!utente\b)[^/"\\\s]+/],
  ["a scratch folder", /\.tmp-|Favorites/],
]

function absolutePaths(text: string): string[] {
  return [...text.matchAll(/(?<![A-Za-z])[A-Za-z]:(\\\\|\\|\/)[^"\s]*/g)].map((match) => match[0])
}

describe("the recorded fixtures", () => {
  const files = readdirSync(DIR).filter((name) => /\.(jsonl|json)$/.test(name))

  test("are there to scan", () => {
    expect(files.length).toBeGreaterThanOrEqual(4)
  })

  for (const name of files) {
    test(`${name} holds nothing of the machine or the account that recorded it`, () => {
      const text = readFileSync(new URL(name, DIR), "utf8")
      for (const [what, pattern] of FORBIDDEN) expect([what, text.match(pattern)?.[0]]).toEqual([what, undefined])
      expect(absolutePaths(text).filter((path) => !ALLOWED_PATH.test(path))).toEqual([])
    })
  }
})
