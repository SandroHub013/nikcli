import { describe, expect, test } from "bun:test"
import { READY_MS, createActivation, type InstalledPlugin, type Phase } from "./activation"
import type { Permission } from "./api"

const entry = (over: Partial<InstalledPlugin> = {}): InstalledPlugin => ({
  id: "hello",
  current: "1.0.0",
  bytes: 1000,
  permissions: ["sessions:read"],
  ...over,
})

function rig(installed: InstalledPlugin | undefined, options: { accepted?: Permission[]; commitFails?: string; rollbackFails?: string } = {}) {
  const log: string[] = []
  const phases: Phase[] = []
  let accepted = options.accepted ?? []
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
    const { activation, log } = rig(entry({ dev: true, current: "0.0.1" }))
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
    expect(log).toEqual(["commit", "schedule 15000"])
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
    const { activation, log } = rig(entry())
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
