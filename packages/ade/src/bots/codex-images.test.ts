import { describe, expect, test } from "bun:test"
import type { Attachment } from "../chat/attachments"
import { createBotTurns } from "./controller"
import type { AgentFile } from "./ragu"
import { runnerById, turnCommand } from "./runners"
import { emptyTalk, type Talk } from "./talk"
import { runTurn, type Turn, type TurnDeps, type TurnRequest } from "./turn"

/*
 * bot-ui-3, 3: Codex gets the pictures attached to a message with its own option, `--image` (codex-cli 0.162.1:
 * `-i, --image <FILE>...` on `exec` and on `exec resume`). Checked with no model turn, against a fake Responses
 * provider: two `--image` before `--` reach the model as two `input_image`, and the message after `--` stays whole.
 */
const bot: AgentFile = {
  identifier: "occhio",
  path: "C:/progetto/.ragu/agent/occhio.md",
  scope: "project",
  description: "",
  mode: "primary",
  prompt: "",
  disabledTools: [],
  runner: "codex",
}
const file = (relative: string, mime: string): Attachment => ({ path: `C:/progetto/${relative}`, relative, mime })
const picture = file("img/a.png", "image/png")
const photo = file("img/b.jpg", "image/jpeg")
const note = file("docs/nota.md", "text/plain")

describe("Codex sees the pictures", () => {
  test("each picture an --image before --, on the first turn and on a resumed one", () => {
    const images = [picture.path, photo.path]
    const first = turnCommand(runnerById("codex"), { bot, message: "guarda", images }).args
    const dash = first.indexOf("--")
    expect(first.slice(dash - 4, dash)).toEqual(["--image", picture.path, "--image", photo.path])
    expect(first.at(-1)).toBe("guarda")
    const next = turnCommand(runnerById("codex"), { bot, message: "e queste?", sessionId: "t-1", images }).args
    const at = next.indexOf("--")
    expect(next.slice(at - 4, at)).toEqual(["--image", picture.path, "--image", photo.path])
    expect(next.slice(-2)).toEqual(["t-1", "e queste?"])
    expect(turnCommand(runnerById("codex"), { bot, message: "x" }).args).not.toContain("--image")
  })

  const machine = () => {
    const spawned: (readonly string[])[] = []
    const host = {
      spawn: async (spawn: { args?: readonly string[] }) => {
        spawned.push(spawn.args ?? [])
        return { kill: () => {}, write: () => {}, resize: () => {} }
      },
    }
    return { spawned, host: async () => host as unknown as Awaited<ReturnType<NonNullable<TurnDeps["host"]>>> }
  }
  const request = (attachments: readonly Attachment[]): TurnRequest => ({
    runner: "codex",
    bot,
    message: "guarda",
    cwd: "C:/progetto",
    attachments,
  })
  const settle = async (done: () => boolean) => {
    for (let i = 0; i < 100 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 0))
  }

  test("the turn checks each picture again, links followed, and gives Codex the pictures only", async () => {
    const m = machine()
    const checked: string[] = []
    const turn = runTurn(request([picture, note]), {
      host: m.host,
      checkAttachment: async (root, path) => {
        checked.push(`${root}|${path}`)
        return "ok"
      },
    })
    await settle(() => m.spawned.length > 0)
    turn.stop()
    await turn.result
    expect(checked).toEqual([`C:/progetto|${picture.path}`])
    const args = m.spawned[0]!
    expect(args).toContain("--image")
    expect(args[args.indexOf("--image") + 1]).toBe(picture.path)
    expect(args.filter((arg) => arg === "--image")).toHaveLength(1)
  })

  test("a picture no longer the project's, or no check to ask: Codex does not start, and the turn says why", async () => {
    for (const deps of [{ checkAttachment: async () => "outside" as const }, {}]) {
      const m = machine()
      const result = await runTurn(request([picture]), { host: m.host, ...deps }).result
      expect(m.spawned).toEqual([])
      expect(result.status).toBe("error")
      expect(result.problem).toContain(picture.path)
    }
  })

  test("the panel sends Codex its pictures as files and names only the other files in the message", () => {
    const requests: TurnRequest[] = []
    const talks: Record<string, Talk> = {}
    const turns = createBotTurns({
      runTurn: (sent): Turn => {
        requests.push(sent)
        return { result: new Promise(() => {}), stop: () => {} }
      },
      talkOf: (path) => talks[path] ?? emptyTalk(),
      update: (path, change) => void (talks[path] = change(talks[path] ?? emptyTalk())),
    })
    turns.send(bot, "guarda", "C:/progetto", [picture, note])
    expect(requests[0]?.attachments).toEqual([picture, note])
    expect(requests[0]?.message).toContain("- docs/nota.md")
    expect(requests[0]?.message).not.toContain("img/a.png")
    // Only pictures: no list under the words at all.
    const only: TurnRequest[] = []
    createBotTurns({
      runTurn: (sent): Turn => {
        only.push(sent)
        return { result: new Promise(() => {}), stop: () => {} }
      },
      talkOf: () => emptyTalk(),
      update: () => {},
    }).send(bot, "guarda", "C:/progetto", [picture])
    expect(only[0]?.message).toBe("guarda")
  })
})
