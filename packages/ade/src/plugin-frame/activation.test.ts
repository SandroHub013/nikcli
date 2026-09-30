import { describe, expect, test } from "bun:test"
import { READY_MS, createActivation, type InstalledPlugin, type Phase, type Unconfirmed } from "./activation"
import type { Permission } from "./api"

const entry = (over: Partial<InstalledPlugin> = {}): InstalledPlugin => ({
  id: "hello",
  current: "1.0.0",
  bytes: 1000,
  permissions: ["sessions:read"],
  ...over,
})

function rig(
  installed: InstalledPlugin | undefined,
  options: { accepted?: Permission[]; commitFails?: string; rollbackFails?: string; unconfirmed?: Unconfirmed } = {},
) {
  const log: string[] = []
  const phases: Phase[] = []
  // What was accepted, unless a test says otherwise: what the installed manifest asks for (the ordinary case of a plugin that was installed).
  let accepted = options.accepted ?? ((installed?.permissions ?? []) as Permission[])
  let mark = options.unconfirmed
  let now = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  let next = 0
  const rejected: string[] = []
  const activation = createActivation("hello", {
    list: async () => installed,
    commit: async () => {
      log.push("commit")
      if (options.commitFails) throw new Error(options.commitFails)
      return installed!.pending!
    },
    rollback: async () => {
      log.push("rollback")
      if (options.rollbackFails) throw new Error(options.rollbackFails)
      return installed!.current!
    },
    accepted: () => accepted,
    accept: (permissions) => {
      log.push(`accept ${permissions.join(",")}`)
      accepted = [...accepted, ...permissions]
    },
    rejected: { add: (_id, version) => void rejected.push(version) },
    unconfirmed: () => mark,
    watch: (version, hadEarlier) => {
      mark = { version, hadEarlier }
      log.push(`watch ${version}`)
    },
    unwatch: () => {
      mark = undefined
      log.push("unwatch")
    },
    schedule: (run, ms) => {
      const id = next++
      timers.set(id, { at: now + ms, run })
      log.push(`schedule ${ms}`)
      return () => void timers.delete(id)
    },
    phase: (phase) => void phases.push(phase),
  })
  return {
    activation,
    log,
    phases,
    rejected,
    mark: () => mark,
    async advance(ms: number) {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id)
          timer.run()
        }
      }
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

describe("opening the panel", () => {
  test("no plugin installed: the placeholder, and nothing is committed", async () => {
    const { activation, log } = rig(undefined)
    await activation.open()
    expect(activation.phase()).toEqual({ kind: "absent" })
    expect(log).toEqual([])
  })

  test("a plugin with neither a current nor a pending version is as good as absent", async () => {
    const { activation } = rig(entry({ current: null, pending: null }))
    await activation.open()
    expect(activation.phase()).toEqual({ kind: "absent" })
  })

  test("a list that fails is the placeholder, not a crash", async () => {
    const activation = createActivation("hello", {
      list: async () => {
        throw new Error("no host")
      },
      commit: async () => "",
      rollback: async () => "",
      accepted: () => [],
      accept() {},
      rejected: { add() {} },
      unconfirmed: () => undefined,
      watch() {},
      unwatch() {},
      schedule: () => () => {},
      phase() {},
    })
    await activation.open()
    expect(activation.phase()).toEqual({ kind: "absent" })
  })

  test("an installed version with nothing pending loads as it is: no commit, no clock", async () => {
    const { activation, log } = rig(entry())
    await activation.open()
    expect(activation.phase()).toEqual({ kind: "loading", version: "1.0.0", committed: false, dev: false, permissions: ["sessions:read"] })
    expect(log).toEqual([])
    activation.ready()
    expect(activation.phase()).toEqual({ kind: "ready", version: "1.0.0" })
  })

  test("a plugin served from a folder is loaded as a development plugin, with no commit and no clock", async () => {
    // Nothing accepted, and nothing asked: a folder's plugin is the developer's own.
    const { activation, log } = rig(entry({ dev: true, current: "0.0.1" }), { accepted: [] })
    await activation.open()
    expect(activation.phase()).toEqual({ kind: "loading", version: "0.0.1", committed: false, dev: true, permissions: ["sessions:read"] })
    expect(log).toEqual([])
  })
})

describe("a pending version: commit, then load, then wait for ready", () => {
  test("its permissions were all accepted: it is committed, and only then is the frame loaded", async () => {
    const { activation, log, phases } = rig(entry({ pending: "1.1.0", pending_permissions: ["sessions:read"] }), {
      accepted: ["sessions:read"],
    })
    await activation.open()
    expect(log).toEqual(["commit", "watch 1.1.0", "schedule 15000"])
    expect(phases.map((phase) => phase.kind)).toEqual(["checking", "loading"])
    expect(activation.phase()).toEqual({ kind: "loading", version: "1.1.0", committed: true, dev: false, permissions: ["sessions:read"] })
  })

  test("ready in time keeps the new version, and the clock is cancelled", async () => {
    const { activation, log, advance, rejected } = rig(entry({ pending: "1.1.0", pending_permissions: [] }))
    await activation.open()
    activation.ready()
    await advance(READY_MS * 2)
    expect(activation.phase()).toEqual({ kind: "ready", version: "1.1.0" })
    expect(log).not.toContain("rollback")
    expect(rejected).toEqual([])
  })

  test("no ready in 15 s: rolled back, the version is remembered as rejected, and the panel is told to load again", async () => {
    const { activation, log, advance, rejected } = rig(entry({ pending: "1.1.0", pending_permissions: [] }))
    await activation.open()
    await advance(READY_MS - 1)
    expect(log).not.toContain("rollback")
    await advance(1)
    expect(log).toContain("rollback")
    expect(rejected).toEqual(["1.1.0"])
    expect(activation.phase()).toEqual({ kind: "rolled-back", from: "1.1.0", to: "1.0.0" })
  })

  test("a first installation that does not start has nothing to go back to: the error stays, with no rollback", async () => {
    const { activation, log, advance, rejected } = rig(entry({ current: null, pending: "1.0.0", pending_permissions: [] }))
    await activation.open()
    await advance(READY_MS)
    expect(log).not.toContain("rollback")
    expect(rejected).toEqual([])
    expect(activation.phase()).toMatchObject({ kind: "failed", version: "1.0.0" })
  })

  test("a rollback that fails is a failure with its reason, not a silent hang", async () => {
    const { activation, advance } = rig(entry({ pending: "1.1.0", pending_permissions: [] }), { rollbackFails: "nessuna versione precedente" })
    await activation.open()
    await advance(READY_MS)
    expect(activation.phase()).toEqual({ kind: "failed", version: "1.1.0", reason: "nessuna versione precedente" })
  })

  test("a commit that fails leaves the version in use running, and is tried again at the next opening", async () => {
    const { activation, phases } = rig(entry({ pending: "1.1.0", pending_permissions: [] }), { commitFails: "non è integra" })
    await activation.open()
    expect(activation.phase()).toEqual({ kind: "loading", version: "1.0.0", committed: false, dev: false, permissions: ["sessions:read"] })
    expect(phases.some((phase) => phase.kind === "failed")).toBe(false)
  })

  test("a first installation whose commit fails shows the error", async () => {
    const { activation } = rig(entry({ current: null, pending: "1.0.0", pending_permissions: [] }), { commitFails: "non è integra" })
    await activation.open()
    expect(activation.phase()).toEqual({ kind: "failed", version: "1.0.0", reason: "non è integra" })
  })

  test("a ready that comes after the rollback changes nothing", async () => {
    const { activation, advance } = rig(entry({ pending: "1.1.0", pending_permissions: [] }))
    await activation.open()
    await advance(READY_MS)
    activation.ready()
    expect(activation.phase().kind).toBe("rolled-back")
  })

  test("closing the panel cancels the clock", async () => {
    const { activation, log, advance } = rig(entry({ pending: "1.1.0", pending_permissions: [] }))
    await activation.open()
    activation.dispose()
    await advance(READY_MS * 2)
    expect(log).not.toContain("rollback")
  })
})

describe("an installed version whose accepted permissions were lost asks again", () => {
  // ADE's own storage was cleared (the webview's profile was reset): the plugin is installed, and nothing says the user accepted what it asks.
  const lost = () => entry({ permissions: ["sessions:read", "storage"] })

  test("it asks, naming what the manifest asks for, instead of loading with no permissions and no word", async () => {
    const { activation, log } = rig(lost(), { accepted: [] })
    await activation.open()
    expect(activation.phase()).toEqual({ kind: "consent", version: "1.0.0", added: ["sessions:read", "storage"], current: "1.0.0" })
    expect(log).toEqual([])
  })

  test("only what is missing is asked", async () => {
    const { activation } = rig(lost(), { accepted: ["sessions:read"] })
    await activation.open()
    expect(activation.phase()).toEqual({ kind: "consent", version: "1.0.0", added: ["storage"], current: "1.0.0" })
  })

  test("yes: it is accepted, and the version in use loads as it is: no commit, no clock", async () => {
    const { activation, log } = rig(lost(), { accepted: [] })
    await activation.open()
    await activation.answer(true)
    expect(log).toEqual(["accept sessions:read,storage"])
    expect(activation.phase()).toEqual({ kind: "loading", version: "1.0.0", committed: false, dev: false, permissions: ["sessions:read", "storage"] })
  })

  test("no: nothing is accepted, it loads anyway (granted only what was accepted, which is decided where the frame is loaded), and it asks again next time", async () => {
    const { activation, log } = rig(lost(), { accepted: [] })
    await activation.open()
    await activation.answer(false)
    expect(log).toEqual([])
    expect(activation.phase()).toMatchObject({ kind: "loading", version: "1.0.0", committed: false })
    await activation.open()
    expect(activation.phase().kind).toBe("consent")
  })

  test("what the manifest asks for and ADE does not know is not a question", async () => {
    const { activation } = rig(entry({ permissions: ["sessions:read", "root"] }), { accepted: ["sessions:read"] })
    await activation.open()
    expect(activation.phase().kind).toBe("loading")
  })

  test("a manifest that asks for nothing never asks", async () => {
    const { activation } = rig(entry({ permissions: [] }), { accepted: [] })
    await activation.open()
    expect(activation.phase().kind).toBe("loading")
  })

  test("a pending version whose permissions were accepted still commits: the question is about the version that stays", async () => {
    const { activation, log } = rig(entry({ permissions: ["storage"], pending: "1.1.0", pending_permissions: ["sessions:read"] }), {
      accepted: ["sessions:read"],
    })
    await activation.open()
    expect(log[0]).toBe("commit")
  })
})

describe("a commit is watched until ready, even if the panel was closed meanwhile", () => {
  const committed = () => entry({ pending: "1.1.0", pending_permissions: [] })

  test("the commit is written down, and ready clears it", async () => {
    const { activation, mark, log } = rig(committed())
    await activation.open()
    expect(mark()).toEqual({ version: "1.1.0", hadEarlier: true })
    activation.ready()
    expect(mark()).toBeUndefined()
    expect(log).toContain("unwatch")
  })

  test("closed inside the 15 s: the version stays written down", async () => {
    const { activation, mark, advance } = rig(committed())
    await activation.open()
    await advance(READY_MS - 1000)
    activation.dispose()
    await advance(READY_MS * 2)
    expect(mark()).toEqual({ version: "1.1.0", hadEarlier: true })
  })

  test("the next opening takes the watch up again, and a version that still does not answer is rolled back", async () => {
    // The panel was closed after the commit: the installed list now says 1.1.0 is current, with nothing pending, and the book remembers it.
    const { activation, log, advance, rejected, mark } = rig(entry({ current: "1.1.0" }), { unconfirmed: { version: "1.1.0", hadEarlier: true } })
    await activation.open()
    expect(activation.phase()).toEqual({ kind: "loading", version: "1.1.0", committed: true, dev: false, permissions: ["sessions:read"] })
    expect(log).toEqual(["schedule 15000"])
    await advance(READY_MS)
    expect(log).toContain("rollback")
    expect(rejected).toEqual(["1.1.0"])
    expect(mark()).toBeUndefined()
    expect(activation.phase().kind).toBe("rolled-back")
  })

  test("and one that answers is confirmed for good: the next opening has no clock", async () => {
    const { activation, log, mark } = rig(entry({ current: "1.1.0" }), { unconfirmed: { version: "1.1.0", hadEarlier: true } })
    await activation.open()
    activation.ready()
    expect(mark()).toBeUndefined()
    log.length = 0
    await activation.open()
    expect(activation.phase()).toMatchObject({ kind: "loading", committed: false })
    expect(log).toEqual([])
  })

  test("a version that was never written down is loaded with no clock", async () => {
    const { activation, log } = rig(entry({ current: "1.1.0" }))
    await activation.open()
    expect(activation.phase()).toMatchObject({ kind: "loading", committed: false })
    expect(log).toEqual([])
  })

  test("a note about another version says nothing about this one", async () => {
    const { activation, log } = rig(entry({ current: "1.2.0" }), { unconfirmed: { version: "1.1.0", hadEarlier: true } })
    await activation.open()
    expect(activation.phase()).toMatchObject({ kind: "loading", version: "1.2.0", committed: false })
    expect(log).toEqual([])
  })

  test("a version with nothing earlier to go back to fails with the error, and is not rolled back", async () => {
    const { activation, log, advance } = rig(entry({ current: "1.0.0" }), { unconfirmed: { version: "1.0.0", hadEarlier: false } })
    await activation.open()
    await advance(READY_MS)
    expect(log).not.toContain("rollback")
    expect(activation.phase()).toMatchObject({ kind: "failed", version: "1.0.0" })
  })

  test("a rollback that fails is a failure with its reason, and the note stays for the next opening", async () => {
    const { activation, advance, mark } = rig(entry({ current: "1.1.0" }), {
      unconfirmed: { version: "1.1.0", hadEarlier: true },
      rollbackFails: "nessuna versione precedente",
    })
    await activation.open()
    await advance(READY_MS)
    expect(activation.phase()).toEqual({ kind: "failed", version: "1.1.0", reason: "nessuna versione precedente" })
    expect(mark()).toEqual({ version: "1.1.0", hadEarlier: true })
  })

  test("a commit that fails writes nothing down", async () => {
    const { activation, mark } = rig(committed(), { commitFails: "non è integra" })
    await activation.open()
    expect(mark()).toBeUndefined()
  })

  test("a development plugin is never watched, whatever the book says", async () => {
    const { activation, log } = rig(entry({ dev: true, current: "1.1.0" }), { unconfirmed: { version: "1.1.0", hadEarlier: true } })
    await activation.open()
    expect(activation.phase()).toMatchObject({ kind: "loading", committed: false, dev: true })
    expect(log).toEqual([])
  })
})

describe("a first installation that was not allowed waits, it is not absent", () => {
  const first = () => entry({ current: null, pending: "1.0.0", pending_permissions: ["sessions:read", "storage"] })

  test("the question has no version to stay on", async () => {
    const { activation, log } = rig(first(), { accepted: [] })
    await activation.open()
    expect(activation.phase()).toEqual({ kind: "consent", version: "1.0.0", added: ["sessions:read", "storage"] })
    expect(log).toEqual([])
  })

  test("«Non ora»: it waits for the user's consent, with what it asks for, and nothing is committed or accepted", async () => {
    const { activation, log } = rig(first(), { accepted: [] })
    await activation.open()
    await activation.answer(false)
    expect(activation.phase()).toEqual({ kind: "waiting", version: "1.0.0", added: ["sessions:read", "storage"] })
    expect(log).toEqual([])
  })

  test("and the answer can still come: yes accepts, commits, and loads", async () => {
    const { activation, log } = rig(first(), { accepted: [] })
    await activation.open()
    await activation.answer(false)
    await activation.answer(true)
    expect(log.slice(0, 2)).toEqual(["accept sessions:read,storage", "commit"])
    expect(activation.phase()).toMatchObject({ kind: "loading", version: "1.0.0", committed: true })
  })

  test("saying no again stays waiting", async () => {
    const { activation, log } = rig(first(), { accepted: [] })
    await activation.open()
    await activation.answer(false)
    await activation.answer(false)
    expect(activation.phase().kind).toBe("waiting")
    expect(log).toEqual([])
  })

  test("the next opening asks again, it does not show the placeholder", async () => {
    const { activation } = rig(first(), { accepted: [] })
    await activation.open()
    await activation.answer(false)
    await activation.open()
    expect(activation.phase().kind).toBe("consent")
  })

  test("a commit that fails after the yes shows the error, as any first installation does", async () => {
    const { activation } = rig(first(), { accepted: [], commitFails: "non è integra" })
    await activation.open()
    await activation.answer(false)
    await activation.answer(true)
    expect(activation.phase()).toEqual({ kind: "failed", version: "1.0.0", reason: "non è integra" })
  })
})

describe("an update that asks for a permission more does not switch on by itself", () => {
  const asking = () => entry({ pending: "1.1.0", pending_permissions: ["sessions:read", "storage"] })

  test("it waits for the answer, names only what is added, and commits nothing meanwhile", async () => {
    const { activation, log } = rig(asking(), { accepted: ["sessions:read"] })
    await activation.open()
    expect(activation.phase()).toEqual({ kind: "consent", version: "1.1.0", added: ["storage"], current: "1.0.0" })
    expect(log).toEqual([])
  })

  test("yes: the addition is accepted, and only then is it committed", async () => {
    const { activation, log } = rig(asking(), { accepted: ["sessions:read"] })
    await activation.open()
    await activation.answer(true)
    expect(log.slice(0, 2)).toEqual(["accept storage", "commit"])
    expect(activation.phase()).toMatchObject({ kind: "loading", version: "1.1.0", committed: true })
  })

  test("no: nothing is accepted or committed, the version in use carries on, and the update stays pending", async () => {
    const { activation, log } = rig(asking(), { accepted: ["sessions:read"] })
    await activation.open()
    await activation.answer(false)
    expect(log).toEqual([])
    expect(activation.phase()).toEqual({ kind: "loading", version: "1.0.0", committed: false, dev: false, permissions: ["sessions:read"] })
  })

  test("the next opening asks again", async () => {
    const { activation } = rig(asking(), { accepted: ["sessions:read"] })
    await activation.open()
    await activation.answer(false)
    await activation.open()
    expect(activation.phase().kind).toBe("consent")
  })

  test("an answer with no question asked does nothing", async () => {
    const { activation, log } = rig(entry(), { accepted: ["sessions:read"] })
    await activation.open()
    await activation.answer(true)
    expect(log).toEqual([])
  })

  test("a name that is not a permission is not a question: it grants nothing and asks nothing", async () => {
    const { activation, log } = rig(entry({ pending: "1.1.0", pending_permissions: ["sessions:read", "root"] }), { accepted: ["sessions:read"] })
    await activation.open()
    expect(log[0]).toBe("commit")
  })
})
