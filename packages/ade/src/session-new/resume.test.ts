import { describe, expect, test } from "bun:test"
import { AGENTS } from "./agents"
import {
  RESUME,
  mintedNikcliId,
  newSessionId,
  planMint,
  planRestore,
  planResume,
  planStart,
  resumePromise,
} from "./resume"

describe("planStart", () => {
  test("an agent that takes an id is started under one, and the id comes back", () => {
    const plan = planStart("claude-code", "11111111-2222-4333-a444-555555555555")
    expect(plan.args).toEqual(["--session-id", "11111111-2222-4333-a444-555555555555"])
    expect(plan.resumeId).toBe("11111111-2222-4333-a444-555555555555")
  })

  test("an agent that does not adds nothing and reports no id", () => {
    /*
     * The honest half. Writing an id down for a CLI that will not take it
     * back would make the pane claim a precision ADE does not have: the
     * restore would look exact and would in fact be "whatever was last".
     */
    for (const id of ["codex", "opencode", "nikcli", "hermes", "terminal"]) {
      const plan = planStart(id, "ignored")
      expect([id, plan.args]).toEqual([id, []])
      expect([id, plan.resumeId]).toEqual([id, undefined])
    }
  })

  test("a UUID is what the CLIs are given, because that is what they validate", () => {
    expect(newSessionId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(newSessionId()).not.toBe(newSessionId())
  })
})

describe("planResume", () => {
  test("a recorded conversation is asked for by name", () => {
    expect(planResume({ agentId: "claude-code", resumeId: "abc" })).toEqual({
      kind: "resume",
      via: "id",
      args: ["--resume", "abc"],
    })
  })

  test("without an id the agent is asked for the most recent one here", () => {
    expect(planResume({ agentId: "codex" })).toEqual({
      kind: "resume",
      via: "last",
      args: ["resume", "--last"],
    })
  })

  test("the most recent one is offered to one pane only", () => {
    // Two panes both taking it reopen the same conversation and then race
    // each other inside it.
    expect(planResume({ agentId: "codex", lastTaken: true })).toEqual({ kind: "fresh" })
  })

  test("an agent with no recipe starts fresh, as it always did", () => {
    // The shell is the clear case: there is no conversation to reopen.
    expect(planResume({ agentId: "terminal" })).toEqual({ kind: "fresh" })
    expect(planResume({ agentId: "inventato" })).toEqual({ kind: "fresh" })
  })

  test("an id the agent never wrote is started again, not resumed", () => {
    // `--resume` on it prints "No conversation found"; `--continue` would hand
    // the pane whatever thread is newest in the project.
    expect(planResume({ agentId: "claude-code", resumeId: "abc", missing: true })).toEqual({
      kind: "fresh",
      resumeId: "abc",
    })
    expect(planStart("claude-code", "abc").args).toEqual(["--session-id", "abc"])
  })

  test("Claude Code's transcript is looked for where Claude Code writes it", () => {
    const path = RESUME["claude-code"]!.transcript!("C:\\Users\\me", "C:\\Users\\me\\Favorites\\nikcli", "abc")
    expect(path).toBe("C:\\Users\\me\\.claude\\projects\\C--Users-me-Favorites-nikcli\\abc.jsonl")
    expect(RESUME["claude-code"]!.transcript!("/home/me/", "/w/a.b", "x")).toBe("/home/me/.claude/projects/-w-a-b/x.jsonl")
    // Past 200 characters Claude Code hashes the name: unknown, so trusted.
    expect(RESUME["claude-code"]!.transcript!("/h", `/${"a".repeat(220)}`, "x")).toBeUndefined()
  })

  test("agy's own record of the latest conversation is read per directory", () => {
    const latest = RESUME.agy!.latest!
    const text = JSON.stringify({
      "C:\\Users\\me": "home-id",
      "C:\\Users\\me\\Favorites\\nikcli": "nikcli-id",
    })
    expect(latest.read(text, "C:/Users/me/Favorites/nikcli")).toBe("nikcli-id")
    expect(latest.read(text, "c:\\users\\me\\favorites\\nikcli\\")).toBe("nikcli-id")
    expect(latest.read(text, "C:\\Users\\me\\elsewhere")).toBeUndefined()
    expect(latest.read("not json", "C:\\Users\\me")).toBeUndefined()
    expect(latest.path("C:\\Users\\me")).toBe("C:\\Users\\me\\.gemini\\antigravity-cli\\cache\\last_conversations.json")
    expect(planResume({ agentId: "agy", resumeId: "x" })).toEqual({ kind: "resume", via: "id", args: ["--conversation", "x"] })
    // No `--session-id` for agy: a vanished conversation cannot be re-pinned.
    expect(planResume({ agentId: "agy", resumeId: "x", missing: true })).toEqual({ kind: "fresh" })
  })

  test("an agent that takes an id but was never given one asks for the last", () => {
    // nikcli, opencode, kimi, agy and the rest: the flag exists, but nothing
    // tells ADE which conversation the CLI opened.
    expect(planResume({ agentId: "nikcli" })).toEqual({
      kind: "resume",
      via: "last",
      args: ["--continue"],
    })
  })
})

describe("planRestore", () => {
  test("two sessions of the same agent in one directory do not both take the last one", () => {
    const plans = planRestore([
      { agentId: "codex", cwd: "/p" },
      { agentId: "codex", cwd: "/p" },
    ])
    expect(plans[0]!.plan).toEqual({ kind: "resume", via: "last", args: ["resume", "--last"] })
    expect(plans[1]!.plan).toEqual({ kind: "fresh" })
  })

  test("a different directory is a different claim", () => {
    const plans = planRestore([
      { agentId: "codex", cwd: "/a" },
      { agentId: "codex", cwd: "/b" },
    ])
    expect(plans.every((entry) => entry.plan.kind === "resume")).toBe(true)
  })

  test("a session resumed by its own id leaves the last one free for the next", () => {
    const plans = planRestore([
      { agentId: "claude-code", cwd: "/p", resumeId: "one" },
      { agentId: "claude-code", cwd: "/p", resumeId: "two" },
      { agentId: "claude-code", cwd: "/p" },
    ])
    expect(plans[0]!.plan).toEqual({ kind: "resume", via: "id", args: ["--resume", "one"] })
    expect(plans[1]!.plan).toEqual({ kind: "resume", via: "id", args: ["--resume", "two"] })
    expect(plans[2]!.plan).toEqual({ kind: "resume", via: "last", args: ["--continue"] })
  })

  test("the sessions come back in the order they were saved", () => {
    const plans = planRestore([
      { agentId: "claude-code", cwd: "/p", resumeId: "first" },
      { agentId: "codex", cwd: "/p" },
    ])
    expect(plans.map((entry) => entry.session.agentId)).toEqual(["claude-code", "codex"])
  })
})

describe("the table and the catalogue", () => {
  test("every recipe names an agent ADE can actually start", () => {
    // A recipe for an id that is not in `agents.ts` is dead code that looks
    // like support.
    const known = new Set(AGENTS.map((agent) => agent.id))
    for (const id of Object.keys(RESUME)) {
      expect([id, known.has(id)]).toEqual([id, true])
    }
  })

  test("an agent whose id ADE pins can also be asked for it back", () => {
    for (const [id, recipe] of Object.entries(RESUME)) {
      if (!recipe.start) continue
      expect([id, recipe.byId !== undefined]).toEqual([id, true])
    }
  })
})

describe("asking nikcli for a conversation", () => {
  test("the id is read out of what the command printed, noise and all", () => {
    const printed = [
      "\u001b[33mwarn\u001b[0m service starting",
      "{",
      '  "id": "ses_f3bdf150dffey1rNNrCSDNsBKu",',
      '  "slug": "neon-mountain",',
      '  "directory": "C:\\\\Users\\\\39349\\\\Favorites\\\\nikcli-ade-s60"',
      "}",
    ].join("\r\n")
    expect(mintedNikcliId(printed)).toBe("ses_f3bdf150dffey1rNNrCSDNsBKu")
  })

  test("half a line is not an id, and neither is somebody else's", () => {
    expect(mintedNikcliId('{ "id": "ses_f3bdf1')).toBeUndefined()
    expect(mintedNikcliId('{ "id": "msg_0c3e73d64001c352ZyUcYJ9leU" }')).toBeUndefined()
    expect(mintedNikcliId("")).toBeUndefined()
  })

  test("the command writes the conversation where the session will run", () => {
    const plan = planMint("nikcli", "Sessione 2 — nikcli")!
    expect(plan.args.slice(0, 2)).toEqual(["api", "session.create"])
    expect(plan.args.at(-1)).toBe(JSON.stringify({ title: "Sessione 2 — nikcli" }))
    expect(plan.read('{ "id": "ses_aaaaaaaaaaaa" }')).toBe("ses_aaaaaaaaaaaa")
  })

  test("only the CLIs that need it are asked; the others are not started twice", () => {
    expect(planMint("nikcli", "t")).toBeDefined()
    for (const id of ["claude-code", "codex", "agy", "opencode", "terminal"]) {
      expect([id, planMint(id, "t")]).toEqual([id, undefined])
    }
  })

  test("with an id of its own, nikcli is pinned like Claude Code", () => {
    expect(planResume({ agentId: "nikcli", resumeId: "ses_one" })).toEqual({
      kind: "resume",
      via: "id",
      args: ["--session", "ses_one"],
    })
  })

  test("the bug this fixes: two nikcli sessions in one directory come back as two", () => {
    const plans = planRestore([
      { agentId: "nikcli", cwd: "/p", resumeId: "ses_one" },
      { agentId: "nikcli", cwd: "/p", resumeId: "ses_two" },
    ])
    expect(plans[0]!.plan).toEqual({ kind: "resume", via: "id", args: ["--session", "ses_one"] })
    expect(plans[1]!.plan).toEqual({ kind: "resume", via: "id", args: ["--session", "ses_two"] })
  })

  test("and without ids it is still the old story, which is why the pane says so", () => {
    const plans = planRestore([
      { agentId: "nikcli", cwd: "/p" },
      { agentId: "nikcli", cwd: "/p" },
    ])
    expect(plans[0]!.plan).toEqual({ kind: "resume", via: "last", args: ["--continue"] })
    expect(plans[1]!.plan).toEqual({ kind: "fresh" })
  })
})

describe("resumePromise", () => {
  test("an id of its own is the only exact promise", () => {
    expect(resumePromise({ agentId: "nikcli", resumeId: "ses_one" })).toBe("exact")
    expect(resumePromise({ agentId: "claude-code", resumeId: "abc", sharedDirectory: true })).toBe("exact")
  })

  test("without one, the most recent here — and not even that with company", () => {
    expect(resumePromise({ agentId: "nikcli" })).toBe("last")
    expect(resumePromise({ agentId: "nikcli", sharedDirectory: true })).toBe("none")
  })

  test("an agent ADE knows nothing about promises nothing", () => {
    expect(resumePromise({ agentId: "terminal" })).toBe("none")
    expect(resumePromise({ agentId: "gemini", resumeId: "x" })).toBe("none")
  })
})
