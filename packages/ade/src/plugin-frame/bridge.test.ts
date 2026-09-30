import { describe, expect, test } from "bun:test"
import type { SessionInfo } from "./api"
import {
  diffSessions,
  needsResync,
  newSalt,
  pluginPicture,
  projectId,
  restrict,
  sameProjects,
  sessionsOf,
  type Picture,
} from "./bridge"

type P = Parameters<typeof pluginPicture>[0]["panes"][number]

const pane = (id: string, over: Partial<P> = {}): P => ({
  id,
  title: id,
  status: "working",
  mode: "—",
  agent: "claude-code",
  model: "claude-code",
  workspaceId: "nikcli",
  projectRoot: "C:/work/nikcli",
  ...over,
})

const open = { name: "nikcli", root: "C:/work/nikcli" }
const SALT_A = "a".repeat(32)
const SALT_B = "b".repeat(32)

const picture = (over: Partial<Parameters<typeof pluginPicture>[0]> = {}) =>
  pluginPicture({ panes: [], facts: () => ({}), decisions: 0, now: 1000, salt: SALT_A, ...over })

describe("pluginPicture: the real sessions and projects", () => {
  test("one session per pane with an agent, none for a file, a browser or a panel, and its project as an opaque id", () => {
    const result = picture({
      open,
      panes: [
        pane("n1", { title: "Dario" }),
        pane("n2", { title: "Lucia" }),
        pane("b1", { browserUrl: "https://example.com", agent: undefined, model: "—" }),
        pane("f1", { filePath: "C:/work/nikcli/a.ts" }),
        pane("pl", { framePlugin: { id: "hello" } }),
        pane("nv", { mode: "nikverse" }),
        pane("n3", { title: "Fabio", workspaceId: "voice", projectRoot: "C:/work/voice" }),
      ],
    })
    expect(result.sessions.map((session) => session.title)).toEqual(["Dario", "Lucia", "Fabio"])
    expect(result.projects.map((project) => project.name)).toEqual(["nikcli", "voice"])
    expect(result.sessions[0]!.project).toBe(projectId(SALT_A, open))
    expect(result.sessions[2]!.project).toBe(projectId(SALT_A, { name: "voice", root: "C:/work/voice" }))
  })

  test("the open project is listed even with no session in it", () => {
    expect(picture({ open }).projects).toEqual([{ id: projectId(SALT_A, open), name: "nikcli" }])
  })

  test("the state is the one the pane's header shows, and a session that kept it keeps its `since`", () => {
    const first = picture({ panes: [pane("a")], now: 1000 })
    const same = picture({ panes: [pane("a")], now: 5000, previous: first })
    expect(same.sessions[0]!.since).toBe(1000)
    const changed = picture({ panes: [pane("a", { status: "error" })], now: 9000, previous: first })
    expect(changed.sessions[0]!.since).toBe(9000)
    expect(changed.sessions[0]!.state).not.toBe(first.sessions[0]!.state)
  })

  test("a suspended session shows as such, from the pane and not from its report", () => {
    const suspended = picture({ panes: [pane("a", { suspended: true })], facts: () => ({ activity: "thinking" }) })
    const live = picture({ panes: [pane("a")], facts: () => ({ activity: "thinking" }) })
    expect(suspended.sessions[0]!.state).not.toBe(live.sessions[0]!.state)
  })

  test("nothing of a transcript or a path is in a session, or anywhere in the picture", () => {
    const result = picture({ open, panes: [pane("a", { cwd: "C:/secret/place", lines: [{ kind: "note", text: "SECRET-LINE" }] } as Partial<P>)] })
    const text = JSON.stringify(result)
    expect(text).not.toContain("SECRET-LINE")
    expect(text).not.toContain("secret")
    expect(text).not.toContain("C:/work")
    expect(text).not.toContain("work/nikcli")
    expect(Object.keys(result.sessions[0]!).sort()).toEqual(["kind", "paneId", "project", "since", "state", "title"])
  })

  test("the decisions counter is carried", () => {
    expect(picture({ decisions: 3 }).decisions).toBe(3)
  })
})

describe("the project id: different for each plugin, and no path in it", () => {
  test("the same folder has a different id for two plugins, and the same one for the same plugin every time", () => {
    const a = projectId(SALT_A, open)
    expect(a).not.toBe(projectId(SALT_B, open))
    expect(a).toBe(projectId(SALT_A, open))
    expect(a).toMatch(/^p[0-9a-f]{16}$/)
  })

  test("it does not contain the path, the name, or any piece of them", () => {
    const projects: { name: string; root?: string }[] = [
      open,
      { name: "voice", root: "D:\\Users\\Alessandro\\Favorites\\voice" },
      { name: "senza-cartella" },
    ]
    for (const project of projects) {
      const id = projectId(SALT_A, project)
      for (const piece of [project.root, project.name, "Alessandro", "Favorites", "work", "nikcli"]) {
        if (piece) expect(id.toLowerCase()).not.toContain(piece.toLowerCase())
      }
    }
  })

  test("a folder is the same folder whatever the slashes and the case, as it is for the sessions", () => {
    expect(projectId(SALT_A, { name: "x", root: "C:\\Work\\NikCLI\\" })).toBe(projectId(SALT_A, { name: "y", root: "c:/work/nikcli" }))
    expect(projectId(SALT_A, { name: "x", root: "C:/a" })).not.toBe(projectId(SALT_A, { name: "x", root: "C:/b" }))
  })

  test("a project with no folder is told by its name", () => {
    expect(projectId(SALT_A, { name: "uno" })).not.toBe(projectId(SALT_A, { name: "due" }))
  })

  test("two plugins shown the same workbench share no id at all", () => {
    const panes = [pane("n1"), pane("n2", { workspaceId: "voice", projectRoot: "C:/work/voice" })]
    const seen = (salt: string) => {
      const result = picture({ open, panes, salt })
      return [...result.projects.map((project) => project.id), ...result.sessions.map((session) => session.project)]
    }
    const first = new Set(seen(SALT_A))
    expect(seen(SALT_B).filter((id) => first.has(id))).toEqual([])
  })

  test("a salt is 32 hex characters, and a new one each time", () => {
    const salt = newSalt()
    expect(salt).toMatch(/^[0-9a-f]{32}$/)
    expect(newSalt()).not.toBe(salt)
  })
})

describe("restrict: a plugin sees only what it was granted", () => {
  const full = picture({ open, panes: [pane("a"), pane("b")], decisions: 2 })

  test("without any permission there is nothing, not even how many", () => {
    const shown = restrict(full, [])
    expect(shown).toEqual({ at: 1000 })
    expect(JSON.stringify(shown)).not.toMatch(/sessions|projects|decisions|paneId|nikcli/)
  })

  test("each permission opens its own part and no other", () => {
    expect(Object.keys(restrict(full, ["sessions:read"])).sort()).toEqual(["at", "sessions"])
    expect(Object.keys(restrict(full, ["projects:read"])).sort()).toEqual(["at", "projects"])
    expect(Object.keys(restrict(full, ["decisions:count"])).sort()).toEqual(["at", "decisions"])
    // The others of the six give no view of ADE at all.
    for (const permission of ["pane:focus", "command:navigation", "storage"] as const) {
      expect(Object.keys(restrict(full, [permission]))).toEqual(["at"])
    }
  })

  test("sessionsOf is a snapshot only when sessions were granted", () => {
    expect(sessionsOf(restrict(full, []))).toBeUndefined()
    expect(sessionsOf(restrict(full, ["sessions:read"]))?.sessions.map((session) => session.paneId)).toEqual(["a", "b"])
  })
})

describe("diffSessions and needsResync", () => {
  const s = (paneId: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
    paneId,
    title: paneId,
    kind: "claude-code",
    project: "p1",
    state: "working",
    since: 1,
    ...over,
  })

  test("a session that appears opens, one that changes state says so, one that goes closes, in that order", () => {
    const events = diffSessions([s("a"), s("b")], [s("a", { state: "waiting" }), s("c")], 50)
    expect(events).toEqual([
      { type: "open", session: s("c") },
      { type: "state", paneId: "a", state: "waiting", at: 50 },
      { type: "close", session: s("b") },
    ])
  })

  test("nothing changed, no events", () => {
    expect(diffSessions([s("a")], [s("a")], 1)).toEqual([])
  })

  test("a new title, kind or project cannot be said by an event: the whole snapshot is sent again", () => {
    expect(needsResync([s("a")], [s("a", { title: "nuovo" })])).toBe(true)
    expect(needsResync([s("a")], [s("a", { kind: "codex" })])).toBe(true)
    expect(needsResync([s("a")], [s("a", { project: "p2" })])).toBe(true)
    expect(needsResync([s("a")], [s("a", { state: "waiting" }), s("b")])).toBe(false)
  })

  test("sameProjects compares ids and names, in order", () => {
    expect(sameProjects([{ id: "1", name: "a" }], [{ id: "1", name: "a" }])).toBe(true)
    expect(sameProjects([{ id: "1", name: "a" }], [{ id: "1", name: "b" }])).toBe(false)
    expect(sameProjects([{ id: "1", name: "a" }], [])).toBe(false)
  })
})

describe("a Picture is data", () => {
  test("it survives structured clone: nothing in it is a function or a class", () => {
    const value: Picture = picture({ open, panes: [pane("a")] })
    expect(structuredClone(value)).toEqual(value)
  })
})
