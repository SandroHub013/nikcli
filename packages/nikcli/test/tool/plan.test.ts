import { afterAll, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { HEADLESS_PERMISSION } from "@/cli/handlers/run"
import { Instance } from "@/project/instance"
import { PermissionNext } from "@/permission/next"
import { Question } from "@/question"
import { Session } from "@/session"
import { PlanEnterTool, PlanExitTool } from "@/tool/plan"
import { ToolRegistry } from "@/tool/registry"
import { runPromiseWithLayer, withCurrentInstance } from "@/effect"
import { makeToolContext, withProjectDirectory } from "../helpers/tool-context"

const dirs: string[] = []
async function projectDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-plan-test-"))
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
const questions = () =>
  runPromiseWithLayer(Question.defaultLayer, withCurrentInstance(Effect.flatMap(Question.Service, (q) => q.list())))
const reject = (requestID: string) =>
  runPromiseWithLayer(
    Question.defaultLayer,
    withCurrentInstance(Effect.flatMap(Question.Service, (q) => q.reject(requestID))),
  )
async function waitForPending() {
  for (let i = 0; i < 100; i++) {
    const list = await questions()
    if (list[0]) return list[0]
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error("no question became pending")
}

const tools = [
  ["plan_enter", PlanEnterTool],
  ["plan_exit", PlanExitTool],
] as const

describe("plan mode tools in a session that forbids question", () => {
  for (const [name, tool] of tools) {
    it(`${name} returns at once, asks nothing and tells the model to carry on`, async () => {
      await withProjectDirectory(await projectDir(), async () => {
        const session = await newSession([{ permission: "question", action: "deny", pattern: "*" }])
        const def = await tool.init()
        const { ctx } = makeToolContext({ sessionID: session.id })
        const result = await Promise.race([
          def.executeAsync({}, ctx),
          // A waiting tool would sit for the 600s tool timeout: fail fast instead.
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${name} waited for an answer`)), 3000)),
        ])
        expect(result.output).toContain("No user is available")
        expect(result.output).toContain("Continue in the current agent")
        expect(await questions()).toHaveLength(0)
      })
    })
  }
})

describe("plan mode tools in an interactive session", () => {
  for (const [name, tool] of tools) {
    it(`${name} still asks the user`, async () => {
      await withProjectDirectory(await projectDir(), async () => {
        const session = await newSession()
        const def = await tool.init()
        const { ctx } = makeToolContext({ sessionID: session.id })
        const running = def.executeAsync({}, ctx)
        const settled = running.then(
          () => "resolved",
          (e) => (e instanceof Question.RejectedError ? "rejected" : "other"),
        )
        const asked = await waitForPending()
        expect(asked.sessionID).toBe(session.id)
        expect(asked.questions[0]?.header).toBe(name === "plan_enter" ? "Plan Mode" : "Build Agent")
        await reject(asked.id)
        expect(await settled).toBe("rejected")
      })
    })
  }
})

describe("what `nikcli run` puts on its sessions", () => {
  const agent: PermissionNext.Ruleset = [{ permission: "*", pattern: "*", action: "allow" }]
  const visible = (id: string, session: PermissionNext.Ruleset) =>
    ToolRegistry.visible(id, { ruleset: PermissionNext.autoApprove(PermissionNext.merge(agent, session)) })

  it("hides question, plan_enter and plan_exit from the model, even under --auto", () => {
    for (const id of ["question", "plan_enter", "plan_exit"]) {
      expect(visible(id, HEADLESS_PERMISSION)).toBe(false)
    }
  })

  it("leaves the other tools alone", () => {
    for (const id of ["bash", "read", "edit", "task"]) expect(visible(id, HEADLESS_PERMISSION)).toBe(true)
  })

  it("without the rules (an interactive session) the plan tools stay visible", () => {
    expect(visible("plan_enter", [])).toBe(true)
    expect(visible("plan_exit", [])).toBe(true)
  })
})
