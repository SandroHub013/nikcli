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
  lastNikcliHere,
  planLastHere,
} from "./resume"

describe("planStart", () => {
  test("an agent that takes an id is started under one, and the id comes back", () => {
    const plan = planStart("claude-code", "11111111-2222-4333-a444-555555555555")
    expect(plan.args).toEqual(["--session-id", "11111111-2222-4333-a444-555555555555"])
    expect(plan.resumeId).toBe("11111111-2222-4333-a444-555555555555")
  })

  /*
   * Read off `grok --help` on 1.0.40, which is the version installed here:
   * `--session-id` starts a new conversation under a UUID the caller picks,
   * `--resume` reopens one by id, `--continue` is the most recent in this
   * directory. The help is explicit that the id must not already exist, which
   * is what `newSessionId` hands it.
   */
  test("grok takes an id on start and asks for it back, like Claude Code", () => {
    const plan = planStart("grok", "11111111-2222-4333-a444-555555555555")
    expect(plan.args).toEqual(["--session-id", "11111111-2222-4333-a444-555555555555"])
    expect(plan.resumeId).toBe("11111111-2222-4333-a444-555555555555")
    expect(planResume({ agentId: "grok", resumeId: "abc" })).toEqual({
      kind: "resume",
      via: "id",
      args: ["--resume", "abc"],
    })
    expect(planResume({ agentId: "grok" })).toEqual({
      kind: "resume",
      via: "last",
      args: ["--continue"],
    })
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
    // opencode, kimi, agy and the rest: the flag exists, but nothing
    // tells ADE which conversation the CLI opened.
    expect(planResume({ agentId: "opencode" })).toEqual({
      kind: "resume",
      via: "last",
      args: ["--continue"],
    })
  })

  test("nikcli without an id asks for this folder's latest, never --continue", () => {
    // `--continue` is the whole project's latest: in a git repository, another worktree's.
    expect(planResume({ agentId: "nikcli" })).toEqual({ kind: "here" })
    expect(RESUME["nikcli"]!.last).toBeUndefined()
    expect(planResume({ agentId: "nikcli", lastTaken: true })).toEqual({ kind: "fresh" })
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

  test("two panes saved on one conversation: only the first reopens it (review, point 1)", () => {
    const plans = planRestore([
      { agentId: "nikcli", cwd: "/p", resumeId: "ses_one" },
      { agentId: "nikcli", cwd: "/p", resumeId: "ses_one" },
      { agentId: "nikcli", cwd: "/p", resumeId: "ses_one" },
    ])
    expect(plans.filter((entry) => entry.plan.kind === "resume")).toHaveLength(1)
    expect(plans[0]!.plan).toEqual({ kind: "resume", via: "id", args: ["--session", "ses_one"] })
    expect(plans[0]!.sharedWith).toBeUndefined()
    // The second looks for its folder's latest (the held id is left out there); the third gets a new one.
    expect(plans[1]!.plan).toEqual({ kind: "here" })
    expect(plans[2]!.plan).toEqual({ kind: "fresh" })
    expect(plans[1]!.sharedWith).toBe(plans[0]!.session)
    expect(plans[2]!.sharedWith).toBe(plans[0]!.session)
  })

  test("the same id for another agent is another conversation", () => {
    const plans = planRestore([
      { agentId: "claude-code", cwd: "/p", resumeId: "abc" },
      { agentId: "claude-code", cwd: "/p", resumeId: "abc" },
      { agentId: "codex", cwd: "/p", resumeId: "abc" },
    ])
    expect(plans.map((entry) => entry.plan.kind)).toEqual(["resume", "fresh", "resume"])
  })

  test("without ids, the folder's latest goes to one pane only", () => {
    const plans = planRestore([
      { agentId: "nikcli", cwd: "/p" },
      { agentId: "nikcli", cwd: "/p" },
      { agentId: "nikcli", cwd: "/q" },
    ])
    expect(plans.map((entry) => entry.plan)).toEqual([{ kind: "here" }, { kind: "fresh" }, { kind: "here" }])
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

/*
 * What `nikcli api session.list -d {"directory":…,"roots":true}` prints
 * (1.399), under a pty: pretty JSON, most recent first. In a git repository
 * the command then stays up, so the list is read as it arrives.
 */
const HERE = "C:\\Users\\me\\Favorites\\relbuild-tmp\\p1-git"
const session = (id: string, updated: number, extra: Record<string, unknown> = {}) => ({
  id,
  slug: "stellar-forest",
  projectID: "3d5878689b15aed8d6226331fb5617dbc0082589",
  directory: HERE,
  title: "Sessione 1 — nikcli · 9269-1-1",
  version: "1.399.0",
  time: { created: updated - 1000, updated },
  skills: [],
  ...extra,
})
const listed = (...entries: unknown[]) => JSON.stringify(entries, null, 2).replace(/\n/g, "\r\n") + "\r\n"

describe("nikcli's latest conversation in this folder", () => {
  const none = new Set<string>()

  test("the most recent of the folder, read from what the command printed", () => {
    const output = listed(session("ses_f22f7ce38ffetKaHXDQ4xUS0u0", 20), session("ses_f2303a230ffeVeq2JI9TTxJVBW", 10))
    expect(lastNikcliHere(output, HERE, none)).toBe("ses_f22f7ce38ffetKaHXDQ4xUS0u0")
    // With the other slash and case Windows hands back.
    expect(lastNikcliHere(output, "c:/users/me/favorites/relbuild-tmp/p1-git/", none)).toBe("ses_f22f7ce38ffetKaHXDQ4xUS0u0")
  })

  test("a conversation another pane holds is left out", () => {
    const output = listed(session("ses_f22f7ce38ffetKaHXDQ4xUS0u0", 20), session("ses_f2303a230ffeVeq2JI9TTxJVBW", 10))
    expect(lastNikcliHere(output, HERE, new Set(["ses_f22f7ce38ffetKaHXDQ4xUS0u0"]))).toBe("ses_f2303a230ffeVeq2JI9TTxJVBW")
    expect(lastNikcliHere(output, HERE, new Set(["ses_f22f7ce38ffetKaHXDQ4xUS0u0", "ses_f2303a230ffeVeq2JI9TTxJVBW"]))).toBeNull()
  })

  test("another folder's, a child's, or a malformed id is never taken, even if the server let it through", () => {
    const output = listed(
      session("ses_aaaaaaaaaaaaaaaaaaaaaaaaaa", 40, { directory: "C:\\Users\\me\\Favorites\\nikcli" }),
      session("ses_bbbbbbbbbbbbbbbbbbbbbbbbbb", 30, { parentID: "ses_cccccccccccccccccccccccccc" }),
      session("not-a-session", 25),
      session("ses_dddddddddddddddddddddddddd", 5),
    )
    expect(lastNikcliHere(output, HERE, none)).toBe("ses_dddddddddddddddddddddddddd")
  })

  test("an empty list is a final no; a list still arriving is not an answer yet", () => {
    expect(lastNikcliHere("[]\r\n", HERE, none)).toBeNull()
    const whole = listed(session("ses_f22f7ce38ffetKaHXDQ4xUS0u0", 20))
    expect(lastNikcliHere(whole.slice(0, whole.indexOf('"skills"') + 14), HERE, none)).toBeUndefined()
    expect(lastNikcliHere("", HERE, none)).toBeUndefined()
  })

  test("a log line with a bracket after the list does not hide it (review, BASSO 3)", () => {
    const output = listed(session("ses_f22f7ce38ffetKaHXDQ4xUS0u0", 20)) + "[warn] plugin loaded [tui]\r\n"
    expect(lastNikcliHere(output, HERE, none)).toBe("ses_f22f7ce38ffetKaHXDQ4xUS0u0")
    expect(lastNikcliHere("[]\r\n[warn] x [y]\r\n", HERE, none)).toBeNull()
  })

  test("a warning line above the list does not hide it", () => {
    const output = "[warn] something about plugins\r\n" + listed(session("ses_f22f7ce38ffetKaHXDQ4xUS0u0", 20))
    expect(lastNikcliHere(output, HERE, none)).toBe("ses_f22f7ce38ffetKaHXDQ4xUS0u0")
  })

  test("the command asks the server for this folder's root conversations", () => {
    const plan = planLastHere("nikcli", HERE, none)!
    expect(plan.args.slice(0, 5)).toEqual(["api", "session.list", "--log-level", "warn", "-d"])
    expect(JSON.parse(plan.args[5]!)).toEqual({ directory: HERE, roots: true, limit: 5 })
    expect(planLastHere("claude-code", HERE, none)).toBeUndefined()
  })
})
