import { describe, expect, test } from "bun:test"
import type { KeyInfo } from "../secrets/keys"
import { XAI_KEY_ENV } from "../secrets/xai-key"
import { isVoiceSetUp, registerVoiceShortcuts, shortcutsNote } from "./global-shortcut"
import { createXaiKeyWatch } from "./xai-key-watch"

const key = (env: string, masked = "••••wxyz"): KeyInfo => ({ name: env, env, agents: [], createdMs: 0, masked })

/**
 * The page as the workbench wires it: the keychain's answer, the signals, and the registration that claims through the gate.
 * Defaults chords and no OpenRouter key: only the xAI key can set voice up.
 */
function page(answers: (Promise<readonly KeyInfo[] | undefined> | readonly KeyInfo[] | undefined | "reject")[]) {
  const state = { masked: undefined as string | null | undefined, unreadable: false }
  const settings = { agentChord: "mod+shift+k", transcriptionChord: "mod+shift+j" }
  const held = new Set<string>()
  const history: string[] = []
  const timers: { ms: number; run: () => void; cancelled: boolean }[] = []
  let notClaimed = false

  const claimNow = async () => {
    const result = await registerVoiceShortcuts(
      { ...settings, hasXaiKey: typeof state.masked === "string" },
      {
        unregisterAll: async () => {
          history.push("unregister")
          held.clear()
        },
        register: async (chord) => {
          history.push(chord)
          held.add(chord)
        },
      },
    )
    notClaimed = result.notSetUp === true
  }
  let pending: Promise<void> = Promise.resolve()
  const watch = createXaiKeyWatch({
    list: async () => {
      const next = answers.shift()
      if (next === "reject") throw new Error("keychain locked")
      return next
    },
    masked: () => state.masked,
    setMasked: (masked) => void (state.masked = masked),
    setUnreadable: (unreadable) => void (state.unreadable = unreadable),
    setUpWith: (hasXaiKey) => isVoiceSetUp({ ...settings, hasXaiKey }),
    claim: () => void (pending = pending.then(claimNow)),
    after: (ms, run) => {
      const timer = { ms, run, cancelled: false }
      timers.push(timer)
      return () => void (timer.cancelled = true)
    },
    delays: [10, 20],
  })
  return {
    state,
    held,
    history,
    timers,
    watch,
    claimNow,
    note: () => shortcutsNote({ notClaimed, xaiKeyMasked: state.masked, unreadable: state.unreadable }),
    settled: () => pending,
  }
}

describe("refreshing the xAI key", () => {
  test("the key arriving claims both shortcuts", async () => {
    const p = page([[key(XAI_KEY_ENV)]])
    await p.claimNow() // the first registration, before the keychain answered
    expect(p.held.size).toBe(0)

    await p.watch.refresh()
    await p.settled()

    expect(p.state.masked).toBe("••••wxyz")
    expect([...p.held].sort()).toEqual(["CommandOrControl+Shift+J", "CommandOrControl+Shift+K"])
    expect(p.note()).toBeUndefined()
  })

  test("removing the key releases them, and claims nothing", async () => {
    const p = page([[key(XAI_KEY_ENV)], []])
    await p.watch.refresh()
    await p.settled()
    expect(p.held.size).toBe(2)
    p.history.length = 0

    await p.watch.refresh()
    await p.settled()

    expect(p.state.masked).toBeNull()
    expect(p.history).toEqual(["unregister"])
    expect(p.held.size).toBe(0)
    expect(p.note()).toBe(shortcutsNote({ notClaimed: true, xaiKeyMasked: null, unreadable: false }))
  })

  test("a failed read is not «no key»: nothing changes, it is said apart, and it is tried again", async () => {
    const p = page(["reject", undefined, [key(XAI_KEY_ENV)]])
    await p.claimNow()

    await p.watch.refresh()
    expect(p.state.masked).toBeUndefined()
    expect(p.state.unreadable).toBe(true)
    expect(p.history).toEqual(["unregister"]) // no claim, no release
    expect(p.note()).toContain("leggere") // «could not be read», never «save a key»
    expect(p.timers).toHaveLength(1)
    expect(p.timers[0]!.ms).toBe(10)

    p.timers[0]!.run() // the retry: still no answer
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(p.state.unreadable).toBe(true)
    expect(p.timers.map((timer) => timer.ms)).toEqual([10, 20])

    p.timers[1]!.run() // and now it answers
    await new Promise((resolve) => setTimeout(resolve, 0))
    await p.settled()
    expect(p.state.unreadable).toBe(false)
    expect(p.state.masked).toBe("••••wxyz")
    expect(p.held.size).toBe(2)
    expect(p.note()).toBeUndefined()
  })

  test("the back-off ends: a few tries, not a loop", async () => {
    const p = page(["reject", "reject", "reject", "reject"])
    await p.watch.refresh()
    p.timers[0]!.run()
    await new Promise((resolve) => setTimeout(resolve, 0))
    p.timers[1]!.run()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(p.timers).toHaveLength(2)
  })

  test("a good read cancels the retry still waiting", async () => {
    const p = page(["reject", [key(XAI_KEY_ENV)]])
    await p.watch.refresh()
    expect(p.timers[0]!.cancelled).toBe(false)
    await p.watch.refresh() // the settings opened and read again
    expect(p.timers[0]!.cancelled).toBe(true)
  })

  test("no key before and none after: nothing is claimed again", async () => {
    const p = page([[], []])
    await p.watch.refresh()
    await p.watch.refresh()
    await p.settled()
    expect(p.state.masked).toBeNull()
    expect(p.history).toEqual([])
  })

  test("a key that stays: no release and claim at every read", async () => {
    const p = page([[key(XAI_KEY_ENV)], [key(XAI_KEY_ENV)]])
    await p.watch.refresh()
    await p.settled()
    p.history.length = 0
    await p.watch.refresh()
    await p.settled()
    expect(p.history).toEqual([])
  })

  test("an old answer arriving after a newer read is dropped", async () => {
    let releaseOld!: (keys: readonly KeyInfo[]) => void
    const old = new Promise<readonly KeyInfo[]>((resolve) => (releaseOld = resolve))
    const p = page([old, [key(XAI_KEY_ENV)]])
    const first = p.watch.refresh() // started first, answers last, with a keychain that still had no key
    const second = p.watch.refresh()
    await second
    expect(p.state.masked).toBe("••••wxyz")
    releaseOld([])
    await first
    expect(p.state.masked).toBe("••••wxyz")
  })

  test("stopping cancels the retry and drops what is in flight", async () => {
    const p = page(["reject"])
    await p.watch.refresh()
    p.watch.stop()
    expect(p.timers[0]!.cancelled).toBe(true)
  })
})
