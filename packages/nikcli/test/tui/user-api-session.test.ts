import { preserveTestEnv } from "../helpers/env"
import { removeTestDir } from "../helpers/fs"
import { afterAll, describe, expect, it } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

// The preload wipes `XDG_DATA_HOME`, which would land the token file on the
// *real* one in this developer's home. Point it at an empty test home before the
// module graph loads, so "no stored token" means what it says.
const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-user-api-home-"))
process.env.NIKCLI_TEST_HOME = testHome
preserveTestEnv(["NIKCLI_TEST_HOME"])
await fs.mkdir(path.join(testHome, "data"), { recursive: true })

const { UserApi } = await import("@tui/util/user-api")
const { UserSession } = await import("@nikcli-ai/util/user-session")

afterAll(async () => {
  await removeTestDir(testHome)
})

const user = { id: "usr_1", email: "owner@example.com" }

/**
 * A transport that answers once, and records what it was asked.
 *
 * The real one is `sdk.fetch` over worker RPC; what matters here is only the
 * shape of the answer, since that is what the startup gate reads.
 */
function sdk(answer: Response | (() => never), url = "http://nikcli.local") {
  const seen: Request[] = []
  return {
    seen,
    sdk: {
      url,
      fetch: (async (input: string, init?: RequestInit) => {
        seen.push(new Request(input, init))
        if (typeof answer === "function") answer()
        return answer
      }) as unknown as typeof fetch,
    },
  }
}

/**
 * The startup gate in `app.tsx` opens the sign-in dialog on this answer, so
 * "the server did not answer" and "the server says nobody is signed in" have
 * to be different things. Collapsing them is what put the sign-in chooser in
 * front of a user who had never signed out: a background service still booting
 * — or restarted mid-launch by an auto-update — reads as signed out.
 */
describe("UserApi.session", () => {
  it("reports the account the server returns", async () => {
    const t = sdk(Response.json(user))
    expect(await UserApi.session(t.sdk)).toEqual({
      status: "signed-in",
      user: user as never,
    })
  })

  it("asks even with no stored token", async () => {
    // `/user/me` answers a caller on this machine from the account row it
    // refreshes itself, so an empty token file is not a local verdict.
    const t = sdk(Response.json(user))
    await UserApi.session(t.sdk)
    expect(t.seen).toHaveLength(1)
    expect(t.seen[0]!.url).toBe("http://nikcli.local/user/me")
    expect(t.seen[0]!.headers.get("authorization")).toBeNull()
  })

  it("reports signed out only when the server refuses", async () => {
    for (const status of [401, 403]) {
      const t = sdk(new Response("Unauthorized", { status }))
      expect(await UserApi.session(t.sdk)).toEqual({ status: "signed-out" })
    }
  })

  it("reports unknown when the server fails rather than refuses", async () => {
    for (const status of [500, 502, 404]) {
      const t = sdk(new Response("nope", { status }))
      expect(await UserApi.session(t.sdk)).toEqual({ status: "unknown" })
    }
  })

  it("reports unknown when the transport throws", async () => {
    const t = sdk(() => {
      throw new Error("connection refused")
    })
    expect(await UserApi.session(t.sdk)).toEqual({ status: "unknown" })
  })

  it("reports unknown before there is a server to ask", async () => {
    const t = sdk(Response.json(user), "")
    expect(await UserApi.session(t.sdk)).toEqual({ status: "unknown" })
    expect(t.seen).toHaveLength(0)
  })

  it("maps the same answers onto me()", async () => {
    expect(await UserApi.me(sdk(Response.json(user)).sdk)).toEqual(user as never)
    expect(await UserApi.me(sdk(new Response("", { status: 401 })).sdk)).toBeNull()
    expect(await UserApi.me(sdk(new Response("", { status: 503 })).sdk)).toBeNull()
  })
})

/**
 * The token file is resolved per call, not bound at import.
 *
 * `Global.Path.data` is a getter so a host that sets `NIKCLI_TEST_HOME` after
 * this module loads is still honoured. Binding it once at import time threw
 * that away and made the answer depend on which file imported this one first:
 * in a shared test process the earliest import fixed the path at the real
 * machine's home, so a later test asking "is a token sent when the store is
 * empty?" was answered with the developer's own token.
 *
 * This asserts the *late* half, which is the half that regressed: the home
 * changes after the module is loaded, and the write and the read must follow it
 * to the new home rather than to whichever one was in effect at import.
 */
describe("UserSession token path", () => {
  it("follows a home that changes after import", async () => {
    const late = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-user-session-late-"))
    try {
      await fs.mkdir(path.join(late, "data"), { recursive: true })
      process.env.NIKCLI_TEST_HOME = late

      await UserSession.save("late-token")
      expect(await UserSession.get()).toBe("late-token")

      // The file is under the *new* home, so the old home never saw a token.
      const written = await fs.readdir(path.join(late, "data"))
      expect(written).toContain("user-session.token")

      await UserSession.clear()
      expect(await UserSession.get()).toBeNull()
    } finally {
      process.env.NIKCLI_TEST_HOME = testHome
      await removeTestDir(late)
    }
  })
})
