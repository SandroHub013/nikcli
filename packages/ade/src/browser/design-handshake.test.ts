import { describe, expect, test } from "bun:test"
import { DESIGN_NO_BRIDGE, designHandshakeReducer, INITIAL_HANDSHAKE_STATE, type HandshakeEvent, type HandshakeState } from "./handshake"

/* D1: in Design mode the handshake never ends on the mirror, a `srcdoc` copy that would run as ADE. */

const run = (...events: HandshakeEvent[]): HandshakeState => events.reduce(designHandshakeReducer, INITIAL_HANDSHAKE_STATE)

describe("the Design-mode handshake", () => {
  test("a timeout settles on none, with the reason, never on the mirror", () => {
    expect(run({ type: "navigate" }, { type: "timeout" })).toEqual({ fidelity: "none", error: DESIGN_NO_BRIDGE })
  })

  test("a ready that claims the mirror is the page itself", () => {
    expect(run({ type: "navigate" }, { type: "ready", mode: "mirror" }).fidelity).toBe("native")
  })

  test("a late ready after the timeout still turns inspection on", () => {
    expect(run({ type: "navigate" }, { type: "timeout" }, { type: "ready" }).fidelity).toBe("native")
  })

  test("no event sequence ever reaches the mirror", () => {
    const events: HandshakeEvent[] = [
      { type: "navigate" },
      { type: "timeout" },
      { type: "ready", mode: "mirror" },
      { type: "no-bridge" },
      { type: "load-error", error: "x" },
    ]
    for (const a of events) for (const b of events) for (const c of events) {
      expect(run(a, b, c).fidelity).not.toBe("mirror")
    }
  })
})
