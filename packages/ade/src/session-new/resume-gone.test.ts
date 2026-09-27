import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { RESUME, nikcliConversationThere, planRestore, planResume } from "./resume"

/*
 * A nikcli pane reopened on a conversation deleted from nikcli (Verifiche,
 * 2026-09-27): ADE passed `--session <id>` anyway, and the pane showed the raw
 * `NotFoundError` and stopped at «Uscito con 1». Now ADE asks nikcli first
 * (`nikcli api session.get`), and a missing conversation is a new one.
 *
 * The outputs below are what nikcli 1.400 printed, with a made-up id.
 */
const ID = "ses_0000000000ADEgoneTest01"
const GONE = `404 \r\n{"name":"NotFoundError","data":{"message":"Session not found: ${ID}"}}\r\n`
const HERE = `{\r\n  "id": "${ID}",\r\n  "slug": "quick-squid",\r\n  "projectID": "global",\r\n`

describe("is the conversation still in nikcli", () => {
  test("the 404 for this id says it is gone", () => {
    expect(nikcliConversationThere(GONE, ID)).toBe("gone")
  })

  test("the conversation's own JSON says it is there, as soon as its id has arrived", () => {
    expect(nikcliConversationThere(HERE, ID)).toBe("here")
  })

  test("half an answer, a warning, or another conversation's 404 is no answer yet", () => {
    expect(nikcliConversationThere("404 ", ID)).toBeUndefined()
    expect(nikcliConversationThere("[warn] slow start\n", ID)).toBeUndefined()
    expect(nikcliConversationThere(GONE.replace(ID, "ses_0000000000ADEotherTest1"), ID)).toBeUndefined()
    expect(nikcliConversationThere(HERE.replace(ID, "ses_0000000000ADEotherTest1"), ID)).toBeUndefined()
  })

  test("it is asked with session.get, the id as a parameter", () => {
    const exists = RESUME.nikcli?.exists
    expect(exists).toBeDefined()
    expect(exists!.args(ID)).toEqual(["api", "session.get", "--log-level", "warn", "--param", `sessionID=${ID}`])
  })
})

describe("a pane whose nikcli conversation is gone", () => {
  test("restarted on its own: a new conversation, and the old id dropped, not reopened", () => {
    const missing = nikcliConversationThere(GONE, ID) === "gone"
    expect(planResume({ agentId: "nikcli", resumeId: ID, missing })).toEqual({ kind: "fresh", gone: true })
  })

  test("in a whole restore, the same", () => {
    const [planned] = planRestore([{ agentId: "nikcli", cwd: "C:/progetto", resumeId: ID, missing: true }])
    expect(planned?.plan).toEqual({ kind: "fresh", gone: true })
  })

  test("still there, it is reopened by id as before", () => {
    const missing = nikcliConversationThere(HERE, ID) === "gone"
    expect(planResume({ agentId: "nikcli", resumeId: ID, missing })).toEqual({
      kind: "resume",
      via: "id",
      args: ["--session", ID],
    })
  })

  test("a CLI that starts under a given id keeps doing so: Claude Code is not `gone`", () => {
    expect(planResume({ agentId: "claude-code", resumeId: ID, missing: true })).toEqual({ kind: "fresh", resumeId: ID })
  })
})

describe("lint: the workbench asks, and drops a gone id", () => {
  const workbench = readFileSync(join(import.meta.dir, "..", "surface", "workbench.tsx"), "utf8")

  test("lint: conversationMissing asks the CLI when there is no transcript file", () => {
    const start = workbench.indexOf("const conversationMissing = async")
    expect(start).toBeGreaterThan(-1)
    const body = workbench.slice(start, workbench.indexOf("\n  }\n", start))
    expect(body.includes("RESUME[agentId]?.exists")).toBe(true)
    expect(body.includes('return answer === "gone"')).toBe(true)
  })

  test("lint: startProcess neither reopens nor keeps a gone id, and says so", () => {
    const start = workbench.indexOf("const conversationGone = ")
    expect(start).toBeGreaterThan(-1)
    const block = workbench.slice(start, start + 700)
    expect(block.includes("updatePane(w, paneId, { resumeId: undefined })")).toBe(true)
    expect(block.includes('t("resume.gone"')).toBe(true)
    expect(block.includes("!conversationGone && recipe?.byId")).toBe(true)
  })
})
