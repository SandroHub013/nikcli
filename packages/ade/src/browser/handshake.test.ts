import { describe, expect, test } from "bun:test"
import {
  HANDSHAKE_TIMEOUT_MS,
  INITIAL_HANDSHAKE_STATE,
  handshakeReducer,
  reduceFidelity,
} from "./handshake"

describe("handshake constants", () => {
  test("defines handshake timeout as 1500ms", () => {
    expect(HANDSHAKE_TIMEOUT_MS).toBe(1500)
  })

  test("initial state is pending", () => {
    expect(INITIAL_HANDSHAKE_STATE.fidelity).toBe("pending")
    expect(INITIAL_HANDSHAKE_STATE.error).toBeUndefined()
  })
})

describe("handshakeReducer", () => {
  describe("transitions from pending", () => {
    test("ready event promotes pending to native", () => {
      const next = handshakeReducer({ fidelity: "pending" }, { type: "ready" })
      expect(next.fidelity).toBe("native")
      expect(next.error).toBeUndefined()
    })

    test("ready event with explicit mirror mode sets mirror", () => {
      const next = handshakeReducer({ fidelity: "pending" }, { type: "ready", mode: "mirror" })
      expect(next.fidelity).toBe("mirror")
    })

    test("timeout event transitions pending to mirror fallback", () => {
      const next = handshakeReducer({ fidelity: "pending" }, { type: "timeout" })
      expect(next.fidelity).toBe("mirror")
    })

    test("load-error event transitions pending to none with error message", () => {
      const next = handshakeReducer(
        { fidelity: "pending" },
        { type: "load-error", error: "Connection refused" },
      )
      expect(next.fidelity).toBe("none")
      expect(next.error).toBe("Connection refused")
    })

    test("navigate event keeps state pending", () => {
      const next = handshakeReducer({ fidelity: "pending" }, { type: "navigate", url: "localhost:3000" })
      expect(next.fidelity).toBe("pending")
    })
  })

  describe("transitions from native", () => {
    test("late timeout does not degrade native state", () => {
      const next = handshakeReducer({ fidelity: "native" }, { type: "timeout" })
      expect(next.fidelity).toBe("native")
    })

    test("subsequent ready keeps native state", () => {
      const next = handshakeReducer({ fidelity: "native" }, { type: "ready" })
      expect(next.fidelity).toBe("native")
    })

    test("navigate resets native state back to pending", () => {
      const next = handshakeReducer({ fidelity: "native" }, { type: "navigate", url: "localhost:5173" })
      expect(next.fidelity).toBe("pending")
    })

    test("load-error transitions native to none", () => {
      const next = handshakeReducer({ fidelity: "native" }, { type: "load-error", error: "Network lost" })
      expect(next.fidelity).toBe("none")
      expect(next.error).toBe("Network lost")
    })
  })

  describe("transitions from mirror", () => {
    test("ready keeps mirror state", () => {
      const next = handshakeReducer({ fidelity: "mirror" }, { type: "ready" })
      expect(next.fidelity).toBe("mirror")
    })

    test("late timeout keeps mirror state", () => {
      const next = handshakeReducer({ fidelity: "mirror" }, { type: "timeout" })
      expect(next.fidelity).toBe("mirror")
    })

    test("navigate resets mirror state back to pending", () => {
      const next = handshakeReducer({ fidelity: "mirror" }, { type: "navigate", url: "localhost:3000" })
      expect(next.fidelity).toBe("pending")
    })

    test("load-error transitions mirror to none", () => {
      const next = handshakeReducer({ fidelity: "mirror" }, { type: "load-error", error: "CORS fetch failed" })
      expect(next.fidelity).toBe("none")
      expect(next.error).toBe("CORS fetch failed")
    })
  })

  describe("transitions from none", () => {
    test("navigate resets none state back to pending", () => {
      const next = handshakeReducer(
        { fidelity: "none", error: "Previous error" },
        { type: "navigate", url: "localhost:3000" },
      )
      expect(next.fidelity).toBe("pending")
      expect(next.error).toBeUndefined()
    })

    test("timeout has no effect on none state", () => {
      const next = handshakeReducer({ fidelity: "none", error: "Failed" }, { type: "timeout" })
      expect(next.fidelity).toBe("none")
      expect(next.error).toBe("Failed")
    })

    test("late ready can promote none to native if bridge arrives", () => {
      const next = handshakeReducer({ fidelity: "none", error: "Failed" }, { type: "ready" })
      expect(next.fidelity).toBe("native")
      expect(next.error).toBeUndefined()
    })
  })

  describe("multi-step lifecycle sequences", () => {
    test("full successful native navigation flow", () => {
      let state = INITIAL_HANDSHAKE_STATE
      expect(state.fidelity).toBe("pending")

      state = handshakeReducer(state, { type: "ready" })
      expect(state.fidelity).toBe("native")

      state = handshakeReducer(state, { type: "navigate" })
      expect(state.fidelity).toBe("pending")

      state = handshakeReducer(state, { type: "ready" })
      expect(state.fidelity).toBe("native")
    })

    test("fallback to mirror and subsequent re-navigation", () => {
      let state = INITIAL_HANDSHAKE_STATE

      // Handshake times out -> falls back to mirror
      state = handshakeReducer(state, { type: "timeout" })
      expect(state.fidelity).toBe("mirror")

      // Mirror bridge loads
      state = handshakeReducer(state, { type: "ready" })
      expect(state.fidelity).toBe("mirror")

      // User navigates somewhere else -> resets to pending
      state = handshakeReducer(state, { type: "navigate" })
      expect(state.fidelity).toBe("pending")
    })

    test("failure to none and recovery on navigation", () => {
      let state = INITIAL_HANDSHAKE_STATE

      state = handshakeReducer(state, { type: "load-error", error: "404 Not Found" })
      expect(state.fidelity).toBe("none")
      expect(state.error).toBe("404 Not Found")

      state = handshakeReducer(state, { type: "navigate" })
      expect(state.fidelity).toBe("pending")
      expect(state.error).toBeUndefined()
    })
  })

  describe("reduceFidelity helper", () => {
    test("reduces fidelity directly", () => {
      expect(reduceFidelity("pending", { type: "ready" })).toBe("native")
      expect(reduceFidelity("pending", { type: "timeout" })).toBe("mirror")
      expect(reduceFidelity("pending", { type: "load-error" })).toBe("none")
      expect(reduceFidelity("native", { type: "navigate" })).toBe("pending")
      expect(reduceFidelity("mirror", { type: "navigate" })).toBe("pending")
      expect(reduceFidelity("none", { type: "navigate" })).toBe("pending")
    })
  })
})
