import { describe, expect, test } from "bun:test"
import type { getHost } from "../host/shell"
import { turnsRunning } from "./terms"
import { runTurn } from "./turn"

/*
 * A host whose killed processes never report an exit, which is what the
 * desktop host does: `pty_kill` removes the session before anything can say
 * it ended.
 */
let spawned = 0
let killed = 0
const host = (async () => ({
  spawn: async () => {
    spawned++
    return { kill: () => void killed++ }
  },
})) as unknown as typeof getHost

describe("bots/turn", () => {
  test("a stopped turn ends and gives its slot back, though the process never reports an exit", async () => {
    for (let i = 0; i < 4; i++) {
      const turn = runTurn({ runner: "claude", message: `domanda ${i}` }, host)
      await new Promise((r) => setTimeout(r, 5))
      turn.stop()
      expect((await turn.result).status).toBe("stopped")
    }
    expect(spawned).toBe(4)
    expect(killed).toBe(4)
    expect(turnsRunning("claude")).toBe(0)
  })

  test("a turn stopped before its process started is killed as soon as it starts, and ends", async () => {
    const turn = runTurn({ runner: "claude", message: "subito fermata" }, host)
    turn.stop()
    expect((await turn.result).status).toBe("stopped")
    expect(turnsRunning("claude")).toBe(0)
  })
})
