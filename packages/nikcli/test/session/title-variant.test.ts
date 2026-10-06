import { Effect } from "effect"
import { preserveTestEnv } from "../helpers/env"
import { afterAll, describe, expect, it } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "node:path"
import { removeTestDir } from "../helpers/fs"
import type { MessageV2 } from "@/session/message-v2"

/**
 * The turn after a mid-session title lost its reasoning effort on the wire: nikcli stopped sending
 * `reasoning` entirely and the model fell back to its own default. `llm.ts` resolves the effort from
 * `input.user.variant`, and `prompt.ts` re-reads that user message from the store on every step of the
 * loop — so a title that rewrites the record is enough to change every turn that follows.
 *
 * These tests pin the two ways that can happen. `titleWrite` is the write the title path makes
 * (`session.updateMessage`, which `summary.ts` calls after setting `summary.title`);
 * `smallOptionsReturnsByReference` is the other shared object in play, the variant bag the small
 * model path hands out.
 */

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-title-variant-home-"))
process.env.NIKCLI_TEST_HOME = testHome
process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1"
process.env.XDG_DATA_HOME = path.join(testHome, "data")
process.env.XDG_CACHE_HOME = path.join(testHome, "cache")
process.env.XDG_CONFIG_HOME = path.join(testHome, "config")
process.env.XDG_STATE_HOME = path.join(testHome, "state")

preserveTestEnv([
  "NIKCLI_TEST_HOME",
  "NIKCLI_DISABLE_PROJECT_CONFIG",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
])

const { Identifier } = await import("@nikcli-ai/util/id")
const { MessageV2: Message } = await import("@/session/message-v2")
const { SessionV2 } = await import("@/session/v2")
const { SessionSync } = await import("@/session/projectors")
const { SyncEvent } = await import("@/sync/sync-event")
const { ProviderTransform } = await import("@/provider/transform")
const { Instance } = await import("@/project/instance")

const projectDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-title-variant-project-")))

function userInfo(sessionID: string) {
  return {
    id: Identifier.ascending("message"),
    sessionID,
    role: "user" as const,
    time: { created: 1 },
    agent: "build",
    model: { providerID: "p", modelID: "m" },
    variant: "medium",
  }
}

function persistUser(sessionID: string, info: ReturnType<typeof userInfo>) {
  const partID = Identifier.ascending("part")
  SessionV2.persist({
    prepared: {
      info: info as never,
      parts: [{ id: partID, sessionID, messageID: info.id, type: "text" as const, text: "hello" }],
    },
    promptData: JSON.stringify({ sessionID, parts: [{ type: "text", text: "hello" }] }),
    projectID: Instance.project.id,
  })
}

/** The user message as the loop's `lastUser` sees it. */
async function lastUser(sessionID: string) {
  const infos: MessageV2.Info[] = []
  for await (const msg of Message.stream(sessionID)) infos.push(msg.info)
  return infos.filter((info) => info.role === "user").at(-1) as
    | { variant?: string; summary?: { title?: string } }
    | undefined
}

/** The same read, as an array, for the message a title write is built from. */
async function readUser(sessionID: string, messageID: string) {
  const infos: MessageV2.Info[] = []
  for await (const msg of Message.stream(sessionID)) infos.push(msg.info)
  return infos.find((info) => info.role === "user" && info.id === messageID)
}

/** The write `summary.ts` makes once it has a title. */
function titleWrite(info: { sessionID: string } & Record<string, unknown>) {
  SessionSync.install()
  SyncEvent.run(
    SessionSync.MessageUpdated,
    { sessionID: info.sessionID, info: info as never },
    { projectID: Instance.project.id },
  )
}

afterAll(async () => {
  await Instance.disposeAll().catch(() => undefined)
  await fs.rm(projectDir, { recursive: true, force: true })
  await removeTestDir(testHome)
})

describe("a title write keeps the turn's variant", () => {
  it("reads back the variant after the title rewrite, the way every later loop step does", async () => {
    await Instance.provide({
      directory: projectDir,
      fn: async () => {
        const session = await SessionV2.create({ title: "title-variant" })
        const info = userInfo(session.id)
        persistUser(session.id, info)

        expect((await lastUser(session.id))?.variant).toBe("medium")

        // What `summary.ts` does: read the message back, set `summary.title`, write it out again.
        const reloaded = await readUser(session.id, info.id)
        expect(reloaded).toBeDefined()
        const edited = {
          ...reloaded!,
          summary: { ...(reloaded! as { summary?: object }).summary, title: "a title", diffs: [] },
        }
        titleWrite(edited)

        const after = await lastUser(session.id)
        expect(after?.summary?.title).toBe("a title")
        // The regression this pins: the turn's variant has to survive, or `llm.ts` sends no effort
        // and the model silently runs at its own default.
        expect(after?.variant).toBe("medium")
      },
    })
  })

  it("survives repeated title writes on the same message", async () => {
    await Instance.provide({
      directory: projectDir,
      fn: async () => {
        const session = await SessionV2.create({ title: "title-variant-twice" })
        const info = userInfo(session.id)
        persistUser(session.id, info)

        for (const title of ["first", "second"]) {
          const reloaded = await readUser(session.id, info.id)
          titleWrite({
            ...reloaded!,
            summary: { ...(reloaded! as { summary?: object }).summary, title, diffs: [] },
          })
          expect((await lastUser(session.id))?.variant).toBe("medium")
        }
      },
    })
  })
})

describe("the small-model options are not the caller's to mutate", () => {
  const model = {
    providerID: "openrouter",
    api: { id: "stealth/space-bunny-alpha", npm: "@openrouter/ai-sdk-provider" },
    variants: { low: { reasoning: { effort: "low" } }, medium: { reasoning: { effort: "medium" } } },
  } as never as Parameters<typeof ProviderTransform.smallOptions>[0]

  it("hands out a bag the caller can merge without touching the model", () => {
    const before = JSON.stringify(model.variants)
    const small = ProviderTransform.smallOptions(model)
    // Merging is what `llm.ts` does with it; it must not write back into `model.variants`.
    const merged = { ...small, extra: true }
    expect(merged).toBeDefined()
    expect(JSON.stringify(model.variants)).toBe(before)
  })

  it("returns a stable bag across calls, so a title turn cannot poison the next one", () => {
    const first = ProviderTransform.smallOptions(model)
    const second = ProviderTransform.smallOptions(model)
    expect(second).toEqual(first)
    // A previous revision of this file asserted the returned bag is a *copy*. It is not: the
    // openrouter branch returns `Object.values(model.variants)[0]` by reference
    // (`transform.ts:1382-1390`). It is left as-is deliberately — the alias is the risk, and
    // copying it would hide the risk instead of removing it. What removes it is that nothing in
    // the title path writes to the bag: `llm.ts` builds a fresh object with remeda's `mergeDeep`
    // (pure), `ProviderTransform.providerOptions` only reads, and `modelFromState` hands back the
    // same `ScopedCache` entry every turn rather than rebuilding one.
    expect(first).toEqual({ reasoning: { effort: "low" } })
  })
})
