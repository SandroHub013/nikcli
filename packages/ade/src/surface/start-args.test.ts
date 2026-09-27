import { describe, expect, test } from "bun:test"
import { restartOf, startArgsFor } from "./start-args"

/*
 * Review of review-alti, point 1: ALTO 5's restart, proved by running it.
 * A bot's flags and a sign-in's subcommand used to reach the first start
 * only; a restart ran the bare agent on the default model.
 */

/** Where `part` sits in `args` as one run of values, or -1. */
function runAt(args: readonly string[], part: readonly string[]): number {
  for (let at = 0; at + part.length <= args.length; at++) {
    if (part.every((value, offset) => args[at + offset] === value)) return at
  }
  return -1
}

const BOT = ["--agent", "revisore", "--model", "openrouter/google/gemma-4-31b-it:free"]

describe("a pane's start, the first and every restart (review-alti, ALTO 5)", () => {
  test("a bot restarted with no arguments of its own for the start keeps its --agent and --model", () => {
    // What a restart hands: no `extra`, a conversation to reopen.
    const args = startArgsFor("nikcli", { spawnArgs: BOT }, { title: "revisore", opening: ["--session", "ses_1"] })
    const flags = runAt(args, BOT)
    const session = runAt(args, ["--session", "ses_1"])
    expect(flags).toBeGreaterThan(-1)
    expect(session).toBeGreaterThan(-1)
    // The flags before the conversation, as at the first start.
    expect(flags).toBeLessThan(session)
  })

  test("the first start and a restart run the same arguments", () => {
    const first = startArgsFor("claude-code", { spawnArgs: ["--model", "haiku"] }, { title: "bot", opening: [] })
    const again = startArgsFor("claude-code", { spawnArgs: ["--model", "haiku"] }, { title: "bot", opening: [] })
    expect(again).toEqual(first)
    expect(runAt(first, ["--model", "haiku"])).toBeGreaterThan(-1)
  })

  test("what one start alone adds comes last, after the pane's own", () => {
    const args = startArgsFor("codex", { spawnArgs: ["-m", "gpt-5.5"] }, { title: "x", opening: [], extra: ["login"] })
    expect(args.at(-1)).toBe("login")
    expect(runAt(args, ["-m", "gpt-5.5"])).toBeLessThan(args.length - 1)
  })

  test("a pane without arguments of its own adds none", () => {
    const bare = startArgsFor("nikcli", undefined, { title: "s", opening: [] })
    expect(bare).not.toContain("--agent")
    expect(bare).not.toContain("--model")
  })
})

describe("how a pane with no process comes back", () => {
  test("a sign-in runs its sign-in again, and resumes nothing", () => {
    expect(restartOf({ signIn: ["auth", "login"] })).toEqual({ kind: "signIn", extra: ["auth", "login"] })
    const args = startArgsFor(
      "claude-code",
      { signIn: ["auth", "login"] },
      { title: "accesso", opening: [], extra: ["auth", "login"] },
    )
    expect(args.slice(-2)).toEqual(["auth", "login"])
  })

  test("a bot, or any other session, is reopened as a session", () => {
    expect(restartOf({ spawnArgs: BOT })).toEqual({ kind: "session" })
    expect(restartOf({})).toEqual({ kind: "session" })
    expect(restartOf({ signIn: [] })).toEqual({ kind: "session" })
  })
})
