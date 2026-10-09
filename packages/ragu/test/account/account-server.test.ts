import { preserveTestEnv } from "../helpers/env"
import { removeTestDir } from "../helpers/fs"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fsp from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"

/*
 * Brief ragu-via-servizi-nik, package A closed after the merge: the account service talks only to the account server
 * RAGU_ACCOUNT_URL names. It used to refuse Nik's hosts by name in login, poll and refresh, and did not check `orgs`,
 * which fetched from the server saved in the account row: an account saved by an older version, signed in to Nik's
 * issuer, still sent its token there. Now every request goes to the configured server or does not leave.
 */
const testHome = await fsp.mkdtemp(path.join(os.tmpdir(), "ragu-account-server-home-"))
process.env.RAGU_TEST_HOME = testHome
process.env.RAGU_SKIP_PLUGIN_INSTALL = "1"
process.env.XDG_DATA_HOME = path.join(testHome, "data")
process.env.XDG_CACHE_HOME = path.join(testHome, "cache")
process.env.XDG_CONFIG_HOME = path.join(testHome, "config")
process.env.XDG_STATE_HOME = path.join(testHome, "state")
preserveTestEnv([
  "RAGU_TEST_HOME",
  "RAGU_SKIP_PLUGIN_INSTALL",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
])

const { Account } = await import("@/account")
const { runPromiseWithLayer } = await import("@/effect")
const { Database } = await import("@/database/database")

const CONFIGURED = "https://accounts.example.test/"
const ELSEWHERE = "https://old-issuer.example.test/"
const originalFetch = globalThis.fetch
const originalUrl = process.env.RAGU_ACCOUNT_URL

let requested: string[] = []
function fakeFetch(respond: (url: string) => Response) {
  requested = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    requested.push(url)
    return respond(url)
  }) as unknown as typeof fetch
}

function saveAccount(id: string, url: string, expiry: number) {
  const now = Date.now()
  Database.syncNative().run(
    "INSERT OR REPLACE INTO account (id, email, url, access_token, refresh_token, token_expiry, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [id, `${id}@example.test`, url, "access", "refresh", expiry, now, now],
  )
}

type AccountService = Effect.Success<typeof Account.Service>
const run = <A>(f: (account: AccountService) => Effect.Effect<A, unknown>) =>
  runPromiseWithLayer(
    Account.defaultLayer,
    Effect.gen(function* () {
      return yield* f(yield* Account.Service)
    }),
  )

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalUrl === undefined) delete process.env.RAGU_ACCOUNT_URL
  else process.env.RAGU_ACCOUNT_URL = originalUrl
})

afterAll(async () => {
  Database.closeAll()
  await removeTestDir(testHome)
})

describe("the account service talks only to RAGU_ACCOUNT_URL", () => {
  test("without RAGU_ACCOUNT_URL, login says what to set and sends nothing", async () => {
    delete process.env.RAGU_ACCOUNT_URL
    fakeFetch(() => new Response("{}", { status: 500 }))
    await expect(run((account) => account.login())).rejects.toThrow(/RAGU_ACCOUNT_URL/)
    expect(requested).toEqual([])
  })

  test("polling a server other than the configured one sends nothing", async () => {
    process.env.RAGU_ACCOUNT_URL = CONFIGURED
    fakeFetch(() => new Response("{}", { status: 500 }))
    await expect(run((account) => account.poll("code" as never, { serverUrl: ELSEWHERE }))).rejects.toThrow(
      /RAGU_ACCOUNT_URL/,
    )
    expect(requested).toEqual([])
  })

  test("an account saved on another server neither refreshes nor fetches its orgs there", async () => {
    process.env.RAGU_ACCOUNT_URL = CONFIGURED
    fakeFetch(() => new Response("[]", { status: 200 }))
    saveAccount("acc_valid_elsewhere", ELSEWHERE, Date.now() + 3_600_000)
    saveAccount("acc_expired_elsewhere", ELSEWHERE, Date.now() - 1_000)

    await expect(run((account) => account.orgs("acc_valid_elsewhere" as never))).rejects.toThrow(/RAGU_ACCOUNT_URL/)
    await expect(run((account) => account.token("acc_expired_elsewhere" as never))).rejects.toThrow(/RAGU_ACCOUNT_URL/)
    expect(requested).toEqual([])
  })

  test("an account on the configured server still reaches it", async () => {
    process.env.RAGU_ACCOUNT_URL = CONFIGURED
    fakeFetch(() => new Response("not found", { status: 404 }))
    saveAccount("acc_valid_here", CONFIGURED, Date.now() + 3_600_000)

    expect(await run((account) => account.orgs("acc_valid_here" as never))).toEqual([])
    expect(requested).toEqual([`${CONFIGURED}api/user/orgs`])
  })
})
