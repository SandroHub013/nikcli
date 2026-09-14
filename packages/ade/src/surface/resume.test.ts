import { describe, expect, test } from "bun:test"
import { CURRENT_VERSION, parseWorkspace, serializeWorkspace } from "../session/persist"
import {
  addPane,
  createWorkbench,
  fromWorkspaceState,
  isResumable,
  restoredStatus,
  sessionsToResume,
  toWorkspaceState,
  type Pane,
} from "./state"

/*
 * What "the sessions survive" can actually mean.
 *
 * A pty is a child of the app: closing the window kills it, and a machine
 * restart kills everything. No process survives. What survives is the
 * session's identity — its agent, its directory, the task it was given and
 * what it said — and starting that work again on open is the promise this
 * code has to keep.
 */

const session = (over: Partial<Pane> = {}): Pane => ({
  id: "p1",
  title: "agy · rifattorizza",
  status: "working",
  model: "agy",
  mode: "auto",
  agent: "agy",
  cwd: "C:/repo/proj",
  task: "rifattorizza il parser",
  lines: [
    { kind: "step", text: "Letto src/parser.ts" },
    { kind: "shell", text: "bun test" },
  ],
  workspaceId: "proj",
  ...over,
})

/** One save/restore cycle, through the real serialiser. */
function roundTrip(panes: Pane[]) {
  let wb = createWorkbench()
  for (const pane of panes) wb = addPane(wb, pane)
  const saved = parseWorkspace(serializeWorkspace(toWorkspaceState(wb)))
  if (!saved) throw new Error("lo stato salvato non si rilegge")
  return { saved, restored: fromWorkspaceState(saved, "proj") }
}

describe("isResumable", () => {
  test("a live session with a task is", () => {
    expect(isResumable(session())).toBe(true)
    expect(isResumable(session({ status: "waiting" }))).toBe(true)
  })

  test("a finished or failed one is not: there is nothing to resume", () => {
    expect(isResumable(session({ status: "done" }))).toBe(false)
    expect(isResumable(session({ status: "error" }))).toBe(false)
  })

  /*
   * The guard that matters. Relaunching an agent with an empty prompt is not
   * resuming a session, it is opening a new one wearing the same name — and
   * doing it unasked, on every start, for every pane ever left open.
   */
  test("no task means no resume, whatever the status said", () => {
    expect(isResumable(session({ task: undefined }))).toBe(false)
    expect(isResumable(session({ task: "   " }))).toBe(false)
  })

  test("a browser pane and a file pane are not sessions", () => {
    expect(isResumable(session({ browserUrl: "http://localhost:3000" }))).toBe(false)
    expect(isResumable(session({ filePath: "src/a.ts" }))).toBe(false)
  })
})

describe("restoredStatus", () => {
  test("anything that was live becomes done: the process is gone", () => {
    expect(restoredStatus("working")).toBe("done")
    expect(restoredStatus("waiting")).toBe("done")
    expect(restoredStatus("provisioning")).toBe("done")
  })

  test("how a session ended outlives the app that ran it", () => {
    expect(restoredStatus("error")).toBe("error")
    expect(restoredStatus("done")).toBe("done")
  })

  test("a status from a corrupt store does not reach the interface", () => {
    expect(restoredStatus("running")).toBe("done")
    expect(restoredStatus("")).toBe("done")
  })
})

describe("saving and restoring a session", () => {
  test("the task survives, so the work can be started again", () => {
    const { saved } = roundTrip([session()])
    expect(saved.panes[0].task).toBe("rifattorizza il parser")
    expect(saved.panes[0].wasRunning).toBe(true)
  })

  /*
   * Before, every restored pane held exactly one line saying the process was
   * gone — true, and the only thing the user could no longer check, because
   * the output that would have told them what the agent did was discarded
   * along with it.
   */
  test("the transcript survives, with the death appended rather than replacing it", () => {
    const { restored } = roundTrip([session()])
    const texts = restored.panes[0].lines.map((line) => line.text)
    expect(texts[0]).toBe("Letto src/parser.ts")
    expect(texts[1]).toBe("bun test")
    expect(texts[2]).toContain("Sessione ripristinata")
  })

  test("a session that was running says it is being picked up again", () => {
    const { restored } = roundTrip([session()])
    expect(restored.panes[0].activity).toBe("Da riprendere")
    expect(restored.panes[0].lines.at(-1)?.text).toContain("riprendo il compito")
  })

  test("a finished session is restored without that promise", () => {
    const { restored } = roundTrip([session({ status: "done" })])
    expect(restored.panes[0].activity).toBe("Ripristinato")
    expect(restored.panes[0].lines.at(-1)?.text).not.toContain("riprendo")
  })

  test("sessionsToResume names exactly the ones that were live and have a task", () => {
    const { saved } = roundTrip([
      session({ id: "live" }),
      session({ id: "finita", status: "done" }),
      session({ id: "senza-compito", task: undefined }),
      session({ id: "browser", browserUrl: "http://localhost:3000" }),
    ])

    expect(sessionsToResume(saved).map((pane) => pane.id)).toEqual(["live"])
  })

  test("a browser pane is not saved at all", () => {
    const { saved } = roundTrip([session({ id: "b", browserUrl: "http://localhost:3000" })])
    expect(saved.panes).toHaveLength(0)
  })

  test("what is written is the current schema version", () => {
    const { saved } = roundTrip([session()])
    expect(saved.version).toBe(CURRENT_VERSION)
  })
})

describe("a store written by an older ADE", () => {
  /*
   * v2 has no record of what any session was asked to do, so those panes
   * restore visible and inert. Resuming them would mean launching agents with
   * empty prompts — which is why the migration adds nothing and claims
   * nothing.
   */
  test("v2 panes are restored and never resumed", () => {
    const v2 = JSON.stringify({
      version: 2,
      panes: [{ id: "p1", title: "agy", agent: "agy", cwd: "C:/repo", branch: "main", status: "working" }],
      focusedPaneId: "p1",
      currentView: "plancia",
      sidebarWidth: 260,
      projectPath: "C:/repo",
    })

    const saved = parseWorkspace(v2)
    expect(saved).toBeDefined()
    expect(saved!.version).toBe(CURRENT_VERSION)
    expect(saved!.panes[0].id).toBe("p1")
    expect(sessionsToResume(saved!)).toEqual([])

    const restored = fromWorkspaceState(saved!)
    expect(restored.panes[0].status).toBe("done")
  })

  test("a v1 store still migrates the whole way up", () => {
    const v1 = JSON.stringify({
      version: 1,
      panes: [{ id: "p1", title: "agy", agent: "agy", cwd: "C:/repo", branch: "main", status: "done" }],
      view: "plancia",
    })

    const saved = parseWorkspace(v1)
    expect(saved?.version).toBe(CURRENT_VERSION)
    expect(saved?.currentView).toBe("plancia")
  })
})

describe("a damaged store", () => {
  test("a line claiming an unknown kind is not carried into the interface", () => {
    const hostile = JSON.stringify({
      version: CURRENT_VERSION,
      panes: [
        {
          id: "p1",
          title: "t",
          agent: "agy",
          cwd: "C:/repo",
          branch: "main",
          status: "done",
          lines: [{ kind: "error\" onload=alert(1)", text: "ciao" }, { kind: 42, text: "due" }, { text: "senza tipo" }, "non un oggetto"],
        },
      ],
      currentView: "plancia",
      sidebarWidth: 260,
    })

    const saved = parseWorkspace(hostile)
    expect(saved?.panes[0].lines?.map((line) => line.kind)).toEqual(["note", "note", "note"])
  })

  test("a line without text is dropped rather than rendered empty", () => {
    const saved = parseWorkspace(
      JSON.stringify({
        version: CURRENT_VERSION,
        panes: [{ id: "p1", title: "t", agent: "a", cwd: "", branch: "", status: "done", lines: [{ kind: "step" }] }],
        currentView: "plancia",
        sidebarWidth: 260,
      }),
    )
    expect(saved?.panes[0].lines).toEqual([])
  })
})
