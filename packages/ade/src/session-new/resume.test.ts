import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { AGENTS } from "./agents"
import { BOT_SESSION_MARK, botPermission } from "../bots/serve-rules"
import {
  RESUME,
  mintedNikcliId,
  newSessionId,
  planMint,
  planRestore,
  planResume,
  planStart,
  lostConversation,
  resumePromise,
  lastNikcliHere,
  lastTakenFor,
  planLastHere,
  LAST_HERE_LIMIT,
  restoreClaims,
  claimedByRestore,
  openedConversation,
  LIST_COLS,
  MintLedger,
  lastHereBesideMints,
  mintMark,
  startingState,
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
    expect(RESUME["claude-code"]!.transcript!("/home/me/", "/w/a.b", "x")).toBe(
      "/home/me/.claude/projects/-w-a-b/x.jsonl",
    )
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
    expect(planResume({ agentId: "agy", resumeId: "x" })).toEqual({
      kind: "resume",
      via: "id",
      args: ["--conversation", "x"],
    })
    // No `--session-id` for agy: a vanished conversation cannot be re-pinned, and its id is dropped (`gone`), not reopened.
    expect(planResume({ agentId: "agy", resumeId: "x", missing: true })).toEqual({ kind: "fresh", gone: true })
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

describe("the most recent conversation, when one pane is reopened", () => {
  const pane = (id: string, agent: string, cwd: string, resumeId?: string) => ({
    id,
    agent,
    cwd,
    ...(resumeId ? { resumeId } : {}),
  })

  test("nikcli: a pane in another folder, or one holding its own id, does not take it (prove dal vivo 2, B)", () => {
    const mine = pane("b", "nikcli", "C:/proj")
    const elsewhere = [pane("a", "nikcli", "C:/altro"), mine]
    expect(lastTakenFor(mine, elsewhere)).toBe(false)
    expect(planResume({ agentId: "nikcli", lastTaken: lastTakenFor(mine, elsewhere) })).toEqual({ kind: "here" })
    // A pane with its id is left out of nikcli's answer already.
    expect(lastTakenFor(mine, [pane("a", "nikcli", "C:/proj", "ses_1"), mine])).toBe(false)
    // Two without an id in one folder, spelled two ways: the earlier one has it.
    const both = [pane("a", "nikcli", "C:\\Proj\\"), mine]
    expect(lastTakenFor(mine, both)).toBe(true)
    expect(lastTakenFor(both[0]!, both)).toBe(false)
  })

  test("an agent that can only say «the most recent one»: any pane of the folder takes it, another folder does not", () => {
    const mine = pane("b", "claude-code", "C:/proj")
    expect(lastTakenFor(mine, [pane("a", "claude-code", "C:/proj", "id-1"), mine])).toBe(true)
    expect(lastTakenFor(mine, [pane("a", "claude-code", "C:/altro"), mine])).toBe(false)
    expect(lastTakenFor(mine, [pane("a", "nikcli", "C:/proj"), mine])).toBe(false)
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
  })

  /*
   * The strip that says a conversation cannot be found again is about an agent
   * that keeps conversations and lost one. For a terminal `none` means there was
   * never a conversation, so saying it there is the opposite of the truth — and
   * it is what showed on every Terminal pane.
   */
  test("a terminal has no conversations to lose, so that strip is not for it", () => {
    // The same `none` the strip is built on, and the two cases it must not mix.
    expect(resumePromise({ agentId: "terminal" })).toBe("none")
    expect(lostConversation("terminal", "none", false)).toBe(false)
    // An agent that does keep conversations still hears it.
    expect(resumePromise({ agentId: "nikcli", sharedDirectory: true })).toBe("none")
    expect(lostConversation("nikcli", "none", false)).toBe(true)
    // And nothing is announced when the conversation was in fact reopened.
    expect(lostConversation("nikcli", "none", true)).toBe(false)
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
    expect(lastNikcliHere(output, "c:/users/me/favorites/relbuild-tmp/p1-git/", none)).toBe(
      "ses_f22f7ce38ffetKaHXDQ4xUS0u0",
    )
  })

  test("a conversation another pane holds is left out", () => {
    const output = listed(session("ses_f22f7ce38ffetKaHXDQ4xUS0u0", 20), session("ses_f2303a230ffeVeq2JI9TTxJVBW", 10))
    expect(lastNikcliHere(output, HERE, new Set(["ses_f22f7ce38ffetKaHXDQ4xUS0u0"]))).toBe(
      "ses_f2303a230ffeVeq2JI9TTxJVBW",
    )
    expect(
      lastNikcliHere(output, HERE, new Set(["ses_f22f7ce38ffetKaHXDQ4xUS0u0", "ses_f2303a230ffeVeq2JI9TTxJVBW"])),
    ).toBeNull()
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

  test("a bot's conversation is never a pane's, however recent and whatever its title", () => {
    const output = listed(
      session("ses_eeeeeeeeeeeeeeeeeeeeeeeeee", 50, {
        title: "renamed by hand",
        permission: [BOT_SESSION_MARK, ...botPermission("ask")],
      }),
      // Made before the mark: the profile's rules at the end say it.
      session("ses_ffffffffffffffffffffffffff", 40, { permission: [...botPermission("remote-none")] }),
      session("ses_gggggggggggggggggggggggggg", 30, {
        permission: [{ permission: "edit", pattern: "*", action: "ask" }],
      }),
    )
    expect(lastNikcliHere(output, HERE, none)).toBe("ses_gggggggggggggggggggggggggg")
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
    expect(plan.args.slice(0, 4)).toEqual(["api", "session.list", "--log-level", "warn"])
    expect(planLastHere("claude-code", HERE, none)).toBeUndefined()
  })

  /*
   * What reaches the server, not what ADE builds (lettura di Mimo, F2). The
   * first test holds the line ADE builds; the second is a `lint:` on nikcli's
   * own handler, which is the only place the two rules it follows are written:
   * `--param` into the URL's query, `-d` into the body. `session.list` is a
   * GET and reads only the query, so the line must carry no `-d`.
   */
  test("roots and the limit go out as query parameters, and nothing goes in a body", () => {
    // The whole line, not a filtered view of it: the old test ran these args through a
    // stub of nikcli's own parsing, so the prefix and any -d were invisible.
    expect(planLastHere("nikcli", HERE, none)!.args).toEqual([
      "api",
      "session.list",
      "--log-level",
      "warn",
      "--param",
      "roots=true",
      "--param",
      `limit=${LAST_HERE_LIMIT}`,
    ])
  })

  test("lint: nikcli's api handler turns --param into the query and leaves a GET without a body", () => {
    const handler = readFileSync(join(import.meta.dir, "../../../nikcli/src/cli/handlers/api.ts"), "utf8")
    expect(handler).toContain("if (!resolved.route.path.includes(`{${name}}`)) url.searchParams.set(name, value)")
    expect(handler).toContain("new Request(url, { method: resolved.route.method, headers, body: args.data })")
  })
})

/*
 * Lettura di Mimo, F3: two nikcli panes of one folder, neither with an id.
 * The live one is planned `here`; the exited one, earlier in the list, is
 * reopened at the same time, and `lastTakenFor` cannot see a claim whose
 * `session.list` has not answered: both asked for the same conversation.
 */
describe("a restore's claims reach the panes it reopens", () => {
  const folder = "C:\\Progetti\\uno"
  const exited = { id: "p1", agent: "nikcli", cwd: folder }
  const live = { id: "p2", agent: "nikcli", cwd: folder }

  test("the folder planned `here` is taken for the exited pane placed before it", () => {
    const planned = planRestore([{ agentId: "nikcli", cwd: folder, pane: live }])
    expect(planned[0]!.plan.kind).toBe("here")
    // What the pane saw alone: nobody without an id before it.
    expect(lastTakenFor(exited, [exited, live])).toBe(false)
    const claims = restoreClaims(planned)
    expect(claimedByRestore(claims, "nikcli", exited.cwd)).toBe(true)
    // The same folder spelled otherwise is the same claim; another folder or agent is not.
    expect(claimedByRestore(claims, "nikcli", "c:/progetti/uno/")).toBe(true)
    expect(claimedByRestore(claims, "nikcli", "C:/Progetti/due")).toBe(false)
    expect(claimedByRestore(claims, "codex", folder)).toBe(false)
    expect(claimedByRestore(undefined, "nikcli", folder)).toBe(false)
  })

  test("a pane reopened by its own id claims nothing", () => {
    const planned = planRestore([{ agentId: "nikcli", cwd: folder, resumeId: "ses_abcdefgh12345678", pane: live }])
    expect(planned[0]!.plan.kind).toBe("resume")
    expect(claimedByRestore(restoreClaims(planned), "nikcli", folder)).toBe(false)
  })

  test("lint: the restore hands its claims to the exited panes it reopens", () => {
    const workbench = readFileSync(join(import.meta.dir, "../surface/workbench.tsx"), "utf8")
    expect(workbench).toContain("const claims = restoreClaims(planned)")
    expect(workbench).toContain("void reopen(pane, undefined, claims)")
    expect(workbench).toContain(
      "lastTakenFor(pane, wb().panes) || claimedByRestore(claims, agentId, pane.cwd || project()?.root)",
    )
  })
})

/*
 * Lettura di Mimo, F4, scenario A: a pane reopened by the id it saved opens
 * that conversation, though no id comes back from the arguments. The note
 * «conversazione di un'altra cartella» compared the minted id alone, never
 * matched at a restart, and the folder was dropped at every one.
 */
describe("the conversation a start opens", () => {
  test("reopening by the saved id opens that one", () => {
    const plan = planResume({ agentId: "nikcli", resumeId: "ses_abcdefgh12345678" })
    expect(plan).toEqual({ kind: "resume", via: "id", args: ["--session", "ses_abcdefgh12345678"] })
    expect(openedConversation(plan, undefined, "ses_abcdefgh12345678")).toBe("ses_abcdefgh12345678")
  })

  test("a minted or found id is the one opened; the most recent one, or a fresh start, is not known", () => {
    expect(openedConversation({ kind: "here" }, "ses_trovata12345678", undefined)).toBe("ses_trovata12345678")
    expect(
      openedConversation({ kind: "resume", via: "last", args: ["--continue"] }, undefined, "ses_salvata"),
    ).toBeUndefined()
    expect(openedConversation({ kind: "fresh" }, undefined, "ses_salvata")).toBeUndefined()
    expect(openedConversation(undefined, undefined, "ses_salvata")).toBeUndefined()
  })

  test("lint: the other-folder note is kept for the conversation the start actually reopened", () => {
    const workbench = readFileSync(join(import.meta.dir, "../surface/workbench.tsx"), "utf8")
    expect(workbench).toContain("const openedId = openedConversation(resume, mintedId, launched?.resumeId)")
    expect(workbench).toContain(
      "if (resumed && launched?.otherDir && openedId !== undefined && openedId === launched.resumeId) {",
    )
    expect(workbench).toContain("...(openedId !== launched?.resumeId ? { otherDir: undefined } : {}),")
    expect(workbench).not.toContain("mintedId === launched.resumeId")
    expect(workbench).toContain("otherDir: followedFolder(report, workDir, followed ?? {})")
    expect(workbench).toContain("followedFolder(report, pane.cwd, pane)")
  })
})

/* Lettura di Mimo, BASSI F5, F6 and F8. */
describe("one folder rule, and a source the tools can read", () => {
  test("two panes of one folder spelled otherwise share its claim", () => {
    const planned = planRestore([
      { agentId: "nikcli", cwd: "C:\\Progetti\\uno" },
      { agentId: "nikcli", cwd: "c:/progetti/uno/" },
    ])
    expect(planned.map((entry) => entry.plan.kind)).toEqual(["here", "fresh"])
  })

  test("resume.ts has no raw NUL byte: grep and rg read it as text", () => {
    const bytes = readFileSync(join(import.meta.dir, "resume.ts"))
    expect(bytes.includes(0)).toBe(false)
  })

  test("the lists are printed wide", () => {
    expect(LIST_COLS).toBeGreaterThanOrEqual(2000)
  })

  test("lint: the workbench compares folders with sameFolder and prints the lists with LIST_COLS", () => {
    const workbench = readFileSync(join(import.meta.dir, "../surface/workbench.tsx"), "utf8")
    expect(workbench).toContain("sameFolder(pane.cwd || p.root, workDir)")
    expect(workbench).not.toContain("(pane.cwd || p.root) === workDir")
    expect(workbench).toContain("cols: LIST_COLS,")
    expect(workbench).not.toContain("cols: 400,")
  })
})

/*
 * Prova dal vivo 7, 1b: two panes of one folder without an id, the exited
 * one before the live one. The exited one mints a conversation, C; the live
 * one asks for the most recent conversation here in the same second, and
 * `session.list` has C already, the newest, while the mint has not answered
 * ADE yet. The live pane took C, and both were on it.
 */
describe("a conversation being minted is not another pane's «here»", () => {
  const older = "ses_f22f7ce38ffetKaHXDQ4xUS0u0"
  const minted = "ses_f2187fa39ffea42ThcJIS6p5l5"
  const read = (output: string, taken: ReadonlySet<string>) => lastNikcliHere(output, HERE, taken)
  /** The CLI's list, answered at once: what `askCli` hands its reader. */
  const answering = (output: string) => async (reader: (output: string) => string | null | undefined) => reader(output)
  const later = () => new Promise((resolve) => setTimeout(resolve, 5))
  // The pane that minted, still open; the one asking is p2.
  const open = (owner: string) => owner === "p1" || owner === "p3"

  test("a mint under way when the list answers is waited for, and the list read again without it", async () => {
    const mints = new MintLedger()
    let answer!: (id: string | undefined) => void
    // The exited pane: its mint is written on the server, the id not back yet.
    const minting = mints.track(new Promise<string | undefined>((resolve) => (answer = resolve)), "p1")
    // The live pane: the list already has C, the newest.
    let settled = false
    const here = lastHereBesideMints(
      answering(listed(session(minted, 30), session(older, 20))),
      read,
      new Set(),
      mints,
      open,
    ).then((id) => ((settled = true), id))
    await later()
    expect(settled).toBe(false)
    answer(minted)
    expect(await minting).toBe(minted)
    expect(await here).toBe(older)
  })

  test("a mint that answered before the list is left out at once", async () => {
    const mints = new MintLedger()
    await mints.track(Promise.resolve(minted), "p1")
    expect(
      await lastHereBesideMints(
        answering(listed(session(minted, 30), session(older, 20))),
        read,
        new Set(),
        mints,
        open,
      ),
    ).toBe(older)
  })

  test("the minted conversation alone in the folder: none here, and the pane mints its own", async () => {
    const mints = new MintLedger()
    let answer!: (id: string | undefined) => void
    mints.track(new Promise<string | undefined>((resolve) => (answer = resolve)), "p1")
    const here = lastHereBesideMints(answering(listed(session(minted, 30))), read, new Set(), mints, open)
    answer(minted)
    expect(await here).toBeUndefined()
  })

  test("a mint started after the list answered is not waited for, and a failed one does not hold it", async () => {
    const mints = new MintLedger()
    mints.track(Promise.reject(new Error("no answer")), "p1")
    let started = false
    const ask = async (reader: (output: string) => string | null | undefined) => {
      const id = reader(listed(session(older, 20)))
      // Another pane starts minting now: it cannot be in this list.
      mints.track(new Promise<string | undefined>(() => (started = true)), "p3")
      return id
    }
    expect(await lastHereBesideMints(ask, read, new Set(), mints, open)).toBe(older)
    expect(started).toBe(true)
  })

  /*
   * Review of ripristino-quater, BASSO 1: a minted conversation stayed left
   * out for the whole run, though the pane that asked for it had been
   * closed; a later "here" (an exited pane reopened) could not take it.
   */
  test("a conversation minted for a pane since closed is free again", async () => {
    const mints = new MintLedger()
    await mints.track(Promise.resolve(minted), "p1")
    const list = answering(listed(session(minted, 30), session(older, 20)))
    expect(await lastHereBesideMints(list, read, new Set(), mints, (owner) => owner === "p1")).toBe(older)
    // p1 closed.
    expect(await lastHereBesideMints(list, read, new Set(), mints, () => false)).toBe(minted)
  })

  /*
   * Review of ripristino-sexies, nota 1: a mint may take 30 s, and the "here"
   * waiting on it said nothing for up to 45. It waits the list's time at
   * most, then trusts the mark in the minted conversation's title.
   */
  test("a mint slower than the patience: the list read as it is, the marked conversation left out", async () => {
    const mints = new MintLedger()
    mints.track(new Promise<string | undefined>(() => {}), "p1")
    const due: (() => void)[] = []
    const timers = { set: (run: () => void) => due.push(run), clear: () => {} }
    const marked = (output: string, taken: ReadonlySet<string>) => lastNikcliHere(output, HERE, taken, [mintMark("p1")])
    const list = answering(
      listed(session(minted, 30, { title: `Sessione 1 — nikcli${mintMark("p1")}` }), session(older, 20)),
    )
    let settled = false
    const here = lastHereBesideMints(list, marked, new Set(), mints, open, { ms: 15_000, timers }).then(
      (id) => ((settled = true), id),
    )
    await later()
    expect(settled).toBe(false)
    expect(due).toHaveLength(1)
    due[0]!()
    expect(await here).toBe(older)
  })

  test("lint: the patience of a here waiting on a mint is the list's own LIST_MS, never a hand-written number", () => {
    const source = readFileSync(join(import.meta.dir, "resume.ts"), "utf8")
    expect(source).toContain("patience: { ms: number; timers?: Timers } = { ms: LIST_MS },")
  })

  test("lint: the workbench mints through the ledger and asks «here» beside it", () => {
    const workbench = readFileSync(join(import.meta.dir, "../surface/workbench.tsx"), "utf8")
    expect(workbench).toContain("const mints = new MintLedger()")
    expect(workbench).toContain("askCli(command, plan.args, cwd, read, timing).then((id) => {")
    expect(workbench).toContain("return id ?? undefined\n      }),\n      paneId,")
    expect(workbench).toContain("return await lastHereBesideMints(")
    expect(workbench).toContain("(owner) => owner !== paneId && wb().panes.some((pane) => pane.id === owner),")
  })
})

/*
 * Review of ripristino-quater, BASSO 2: a mint past MINT_MS is killed, but
 * nikcli may have written the conversation, and ADE never read its id. Empty
 * and the newest of the folder, it was another pane's "here".
 */
describe("a conversation minted for another open pane is not «here»", () => {
  const real = "ses_f22f7ce38ffetKaHXDQ4xUS0u0"
  const orphan = "ses_f2187fa39ffea42ThcJIS6p5l5"
  const output = listed(
    session(orphan, 30, { title: `Sessione 1 — nikcli${mintMark("n1789476735968-5998-1-1")}` }),
    session(real, 20),
  )

  test("its title says the pane, and the pane is open: left out", () => {
    expect(mintMark("n1789476735968-5998-1-1")).toBe(" · 5998-1-1")
    expect(lastNikcliHere(output, HERE, new Set(), [mintMark("n1789476735968-5998-1-1")])).toBe(real)
    expect(planLastHere("nikcli", HERE, new Set(), [mintMark("n1789476735968-5998-1-1")])!.read(output)).toBe(real)
  })

  test("a pane no longer open, or no mark, leaves it to be taken", () => {
    expect(lastNikcliHere(output, HERE, new Set(), [mintMark("n1789476735968-7777-2-2")])).toBe(orphan)
    expect(lastNikcliHere(output, HERE, new Set())).toBe(orphan)
  })

  test("lint: the workbench titles a mint with its pane's mark and reads the list by the same marks", () => {
    const workbench = readFileSync(join(import.meta.dir, "../surface/workbench.tsx"), "utf8")
    expect(workbench).toContain("const title = `${launched?.title || agent.label || agentId}${mintMark(paneId)}`")
    expect(workbench).toContain(".panes.filter((pane) => pane.id !== paneId)\n      .map((pane) => mintMark(pane.id))")
    expect(workbench).toContain("planLastHere(agentId, cwd, excluded, marks)")
  })
})

/*
 * Prova dal vivo 7, 1b rifatta: the live pane, with a task, reopened its own
 * conversation and was not handed the task again, yet it started "working";
 * its terminal went quiet and it became «Disponibile», not «Sessione ripresa».
 */
describe("a resumed start that types nothing is idle, and says it was resumed", () => {
  test("resumed with a task that is not typed: idle, resumed", () => {
    expect(startingState({ task: "Rispondi OK.", resumed: true, typeIntoResumed: false })).toEqual({
      typesTask: false,
      status: "idle",
      activity: "resumed",
    })
  })

  test("the other starts keep what they said", () => {
    expect(startingState({ task: "", resumed: true, typeIntoResumed: false })).toMatchObject({
      status: "idle",
      activity: "resumed",
    })
    expect(startingState({ task: "Rispondi OK.", resumed: true, typeIntoResumed: true })).toEqual({
      typesTask: true,
      status: "working",
      activity: "resumed",
    })
    expect(startingState({ task: "Rispondi OK.", resumed: false, typeIntoResumed: false })).toEqual({
      typesTask: true,
      status: "working",
      activity: "running",
    })
    expect(startingState({ task: "  ", resumed: false, typeIntoResumed: false })).toEqual({
      typesTask: false,
      status: "idle",
      activity: "ready",
    })
  })

  test("lint: the workbench sets the pane and types the task by the same rule", () => {
    const workbench = readFileSync(join(import.meta.dir, "../surface/workbench.tsx"), "utf8")
    expect(workbench).toContain("const starting = startingState({ task, resumed, typeIntoResumed })")
    expect(workbench).toContain("status: starting.status,")
    expect(workbench).toContain("if (starting.typesTask) {")
    expect(workbench).not.toContain('status: hasTask ? "working" : "idle",')
  })
})
