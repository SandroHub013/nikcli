import { describe, expect, test } from "bun:test"
import { createListenGuard, SLEEP_GAP_MS, LOCK_POLL_MS } from "./listen-guard"

function world() {
  const state = { at: 0, locked: false, wanted: true, listening: true, paused: false, calls: [] as string[] }
  const guard = createListenGuard({
    now: () => state.at,
    isLocked: async () => state.locked,
    shouldListen: () => state.wanted,
    isListening: () => state.listening,
    isPaused: () => state.paused,
    pause: async () => {
      state.calls.push("pause")
      state.listening = false
      state.paused = true
    },
    resume: async () => {
      state.calls.push("resume")
      state.listening = true
      state.paused = false
    },
    restart: async () => {
      state.calls.push("restart")
    },
  })
  const tick = async (after = LOCK_POLL_MS) => {
    state.at += after
    await guard.tick()
  }
  return { state, tick }
}

describe("always-on listening and the state of the PC", () => {
  test("pauses when the PC is locked and comes back by itself at the unlock", async () => {
    const { state, tick } = world()
    await tick()
    expect(state.calls).toEqual([])
    state.locked = true
    await tick()
    await tick()
    expect(state.calls).toEqual(["pause"])
    state.locked = false
    await tick()
    expect(state.calls).toEqual(["pause", "resume"])
    expect(state.listening).toBe(true)
  })

  test("after the PC slept, the microphone is opened again", async () => {
    const { state, tick } = world()
    await tick(SLEEP_GAP_MS + 60_000)
    expect(state.calls).toEqual(["restart"])
  })

  test("waking straight into the lock screen pauses, and the unlock resumes", async () => {
    const { state, tick } = world()
    state.locked = true
    await tick(SLEEP_GAP_MS + 60_000)
    state.locked = false
    await tick()
    expect(state.calls).toEqual(["pause", "resume"])
  })

  test("switched off, or closed by hand, it is left alone", async () => {
    const { state, tick } = world()
    state.listening = false
    await tick()
    state.locked = true
    await tick()
    state.locked = false
    await tick()
    expect(state.calls).toEqual([])

    state.wanted = false
    state.paused = true
    await tick()
    expect(state.calls).toEqual([])
  })

  test("a lock check that fails is read as unlocked", async () => {
    const { state, tick } = world()
    state.paused = true
    state.listening = false
    const guard = createListenGuard({
      now: () => 0,
      isLocked: () => Promise.reject(new Error("no native shell")),
      shouldListen: () => true,
      isListening: () => false,
      isPaused: () => true,
      pause: async () => {},
      resume: async () => void state.calls.push("resume"),
      restart: async () => {},
    })
    await guard.tick()
    expect(state.calls).toEqual(["resume"])
    void tick
  })
})
