import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { HELLO, MIN_NONCE, createHandshake, newNonce } from "./handshake"

const frame = { name: "the frame's window" }
const other = { name: "another window" }

function rig(nonce = newNonce(), window: unknown = frame) {
  const state = { nonce, window }
  return {
    state,
    handshake: createHandshake({ frameWindow: () => state.window, nonce: () => state.nonce }),
  }
}

describe("only the plugin, proving it knows the nonce, is given the port", () => {
  test("a hello from the frame's window with the nonce of this load is accepted", () => {
    const { handshake, state } = rig()
    expect(handshake.hello({ source: frame, data: { type: HELLO, nonce: state.nonce } })).toEqual({ ok: true })
  })

  test("a nonce is 48 hex characters, and a new one each time", () => {
    const first = newNonce()
    expect(first).toMatch(/^[0-9a-f]{48}$/)
    expect(newNonce()).not.toBe(first)
    expect(first.length).toBeGreaterThanOrEqual(MIN_NONCE)
  })

  test("a hello with no nonce, a wrong one, or one of another load is refused, and said to be from the frame", () => {
    const { handshake, state } = rig()
    const stale = newNonce()
    for (const data of [
      { type: HELLO },
      { type: HELLO, nonce: "" },
      { type: HELLO, nonce: "0".repeat(48) },
      { type: HELLO, nonce: stale },
      { type: HELLO, nonce: state.nonce.slice(0, -1) },
      { type: HELLO, nonce: state.nonce + "0" },
      { type: HELLO, nonce: 7 },
      { type: HELLO, nonce: [state.nonce] },
      { type: HELLO, nonce: null },
    ]) {
      const verdict = handshake.hello({ source: frame, data })
      expect([data, verdict.ok, !verdict.ok && verdict.fromFrame]).toEqual([data, false, true])
    }
  })

  test("the nonce of the load before is not the nonce of the load after", () => {
    const { handshake, state } = rig()
    const before = state.nonce
    state.nonce = newNonce()
    expect(handshake.hello({ source: frame, data: { type: HELLO, nonce: before } }).ok).toBe(false)
    expect(handshake.hello({ source: frame, data: { type: HELLO, nonce: state.nonce } }).ok).toBe(true)
  })

  test("the right nonce from another window is refused, and is not a line worth writing", () => {
    const { handshake, state } = rig()
    const verdict = handshake.hello({ source: other, data: { type: HELLO, nonce: state.nonce } })
    expect(verdict.ok).toBe(false)
    expect(!verdict.ok && verdict.fromFrame).toBe(false)
    for (const source of [null, undefined, globalThis]) {
      expect(handshake.hello({ source, data: { type: HELLO, nonce: state.nonce } }).ok).toBe(false)
    }
  })

  test("with no frame there is nobody to give the port to, even if the message names the nonce", () => {
    const { handshake, state } = rig(undefined, undefined)
    expect(handshake.hello({ source: undefined, data: { type: HELLO, nonce: state.nonce } }).ok).toBe(false)
    const none = rig(undefined, null)
    expect(none.handshake.hello({ source: null, data: { type: HELLO, nonce: none.state.nonce } }).ok).toBe(false)
  })

  test("a message of the frame that is not a hello is refused", () => {
    const { handshake, state } = rig()
    for (const data of [null, undefined, "hello", 3, [], {}, { type: "ready" }, { type: "plugin:port", nonce: state.nonce }]) {
      const verdict = handshake.hello({ source: frame, data })
      expect([data, verdict.ok]).toEqual([data, false])
    }
  })

  test("lint: every load of the frame is given a new nonce, in the fragment, and the port goes only to the window that proved it", () => {
    const pane = readFileSync(join(import.meta.dir, "plugin-pane.tsx"), "utf8")
    const from = pane.indexOf("const reloadFrame = () => {")
    expect(from).toBeGreaterThan(0)
    const reload = pane.slice(from, pane.indexOf("}", from))
    expect(reload).toContain("nonce = newNonce()")
    expect(reload.indexOf("nonce = newNonce()")).toBeLessThan(reload.indexOf("setFrameSrc(pluginFrameUrl(props.pluginId, nonce))"))
    // Both ways the frame is loaded go through it: a new activation and the frame coming back after it was let go.
    expect(pane.match(/reloadFrame\(\)/g)).toHaveLength(2)
    expect(readFileSync(join(import.meta.dir, "frame-url.ts"), "utf8")).toContain("#n=${nonce}")
    expect(pane).toContain("connect(event.source as Window)")
    expect(pane).not.toContain("frame!.contentWindow")
  })

  test("a nonce shorter than ADE ever makes is never believed, even when both sides agree on it", () => {
    const { handshake } = rig("abc")
    expect(handshake.hello({ source: frame, data: { type: HELLO, nonce: "abc" } }).ok).toBe(false)
    const empty = rig("")
    expect(empty.handshake.hello({ source: frame, data: { type: HELLO, nonce: "" } }).ok).toBe(false)
  })
})
