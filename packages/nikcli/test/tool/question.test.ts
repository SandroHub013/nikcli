import { afterAll, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { PermissionNext } from "@/permission/next"
import { Question } from "@/question"
import { Session } from "@/session"
import { QuestionTool } from "@/tool/question"
import { ToolRegistry } from "@/tool/registry"
import { runPromiseWithLayer, withCurrentInstance } from "@/effect"
import { makeToolContext, withProjectDirectory } from "../helpers/tool-context"

const params = {
  questions: [{ question: "Which one?", header: "Pick", options: [{ label: "A", description: "first" }] }],
}
const denyAll: PermissionNext.Ruleset = [{ permission: "question", action: "deny", pattern: "*" }]

const dirs: string[] = []
async function projectDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-question-test-"))
  dirs.push(dir)
  return dir
}
afterAll(async () => {
  await Instance.disposeAll().catch(() => undefined)
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
})

function newSession(permission?: PermissionNext.Ruleset) {
  return runPromiseWithLayer(
    Session.defaultLayer,
    withCurrentInstance(
      Effect.flatMap(Session.Service, (s) =>
        s.createNext({ directory: Instance.directory, ...(permission ? { permission } : {}) }),
      ),
    ),
  )
}

function pending() {
  return runPromiseWithLayer(
    Question.defaultLayer,
    withCurrentInstance(Effect.flatMap(Question.Service, (q) => q.list())),
  )
}

function reply(requestID: string) {
  return runPromiseWithLayer(
    Question.defaultLayer,
    withCurrentInstance(Effect.flatMap(Question.Service, (q) => q.reply({ requestID, answers: [["A"]] }))),
  )
}

describe("QuestionTool in a session that forbids question", () => {
  it("returns at once, tells the model nobody can answer, and asks nothing", async () => {
    const dir = await projectDir()
    await withProjectDirectory(dir, async () => {
      const session = await newSession(denyAll)
      const def = await QuestionTool.init()
      const { ctx } = makeToolContext({ sessionID: session.id })
      const started = Date.now()
      const result = await Promise.race([
        def.executeAsync(params, ctx),
        // A waiting tool would sit here for the 600s tool timeout: fail fast instead.
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("question waited for an answer")), 3000)),
      ])
      expect(Date.now() - started).toBeLessThan(3000)
      expect(result.output).toContain("No user is available")
      expect(result.output).toContain("continue")
      expect(await pending()).toHaveLength(0)
    })
  })

  it("still asks when the session only denies question for a specific pattern", async () => {
    const dir = await projectDir()
    await withProjectDirectory(dir, async () => {
      const session = await newSession([{ permission: "question", action: "deny", pattern: "secret/*" }])
      const def = await QuestionTool.init()
      const { ctx } = makeToolContext({ sessionID: session.id })
      const running = def.executeAsync(params, ctx)
      const asked = await waitForPending()
      await reply(asked.id)
      expect((await running).output).toContain('"Which one?"="A"')
    })
  })
})

describe("QuestionTool in an interactive session", () => {
  it("asks and returns the user's answer as before", async () => {
    const dir = await projectDir()
    await withProjectDirectory(dir, async () => {
      const session = await newSession()
      const def = await QuestionTool.init()
      const { ctx } = makeToolContext({ sessionID: session.id })
      const running = def.executeAsync(params, ctx)
      const asked = await waitForPending()
      expect(asked.sessionID).toBe(session.id)
      await reply(asked.id)
      const result = await running
      expect(result.output).toContain("User has answered your questions")
      expect(result.output).toContain('"Which one?"="A"')
    })
  })

  it("asks when the session cannot be read, rather than swallowing the question", async () => {
    const dir = await projectDir()
    await withProjectDirectory(dir, async () => {
      const def = await QuestionTool.init()
      const { ctx } = makeToolContext({ sessionID: "ses_doesnotexist" })
      const running = def.executeAsync(params, ctx)
      const asked = await waitForPending()
      await reply(asked.id)
      expect((await running).output).toContain("User has answered")
    })
  })
})

async function waitForPending() {
  for (let i = 0; i < 100; i++) {
    const list = await pending()
    if (list[0]) return list[0]
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error("no question became pending")
}

// The model-facing schema is built from the merged agent + session rules
// (session/tools.ts). These pin the rule semantics that hiding relies on, with the
// `--auto` rewrite that `nikcli run` applies on top.
describe("question visibility to the model", () => {
  const agent: PermissionNext.Ruleset = [
    { permission: "*", pattern: "*", action: "allow" },
    { permission: "question", pattern: "*", action: "allow" },
  ]
  const visible = (session: PermissionNext.Ruleset, auto: boolean) => {
    const merged = PermissionNext.merge(agent, session)
    return ToolRegistry.visible("question", { ruleset: auto ? PermissionNext.autoApprove(merged) : merged })
  }

  it("is hidden when the session denies it for every pattern, with or without --auto", () => {
    expect(visible(denyAll, false)).toBe(false)
    expect(visible(denyAll, true)).toBe(false)
  })

  it("stays visible when the session denies it only for a specific pattern", () => {
    const scoped: PermissionNext.Ruleset = [{ permission: "question", action: "deny", pattern: "secret/*" }]
    expect(visible(scoped, false)).toBe(true)
    expect(visible(scoped, true)).toBe(true)
  })

  it("stays visible for a session with no rules", () => {
    expect(visible([], false)).toBe(true)
    expect(visible([], true)).toBe(true)
  })
})
